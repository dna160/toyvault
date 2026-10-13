import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { IMAGE_DEFAULTS } from "@toyvault/shared";
import exifr from "exifr";
import sharp from "sharp";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";

// Deterministic helpers only: hashing, resizing, EXIF, QR/barcode decoding and contact
// sheets. Nothing here classifies or decides anything; that is Claude's job.

const require = createRequire(import.meta.url);
let zxingReady = false;

function ensureZxing() {
  if (zxingReady) return;
  // Load the decoder from node_modules instead of the library's default CDN fetch.
  const wasmBinary = readFileSync(require.resolve("zxing-wasm/reader/zxing_reader.wasm"));
  prepareZXingModule({ overrides: { wasmBinary: wasmBinary.buffer as ArrayBuffer }, fireImmediately: true });
  zxingReady = true;
}

export interface DecodedCode {
  format: string;
  text: string;
}

export interface ProcessedPhoto {
  sha256: string;
  phash: string;
  width: number;
  height: number;
  capturedAt: string | null;
  contentType: "image/jpeg" | "image/png";
  preview: Buffer;
  thumb: Buffer;
  codes: DecodedCode[];
}

export async function processPhoto(
  original: Buffer,
  opts: { previewPx?: number; thumbPx?: number } = {},
): Promise<ProcessedPhoto> {
  const previewPx = opts.previewPx ?? IMAGE_DEFAULTS.previewPx;
  const thumbPx = opts.thumbPx ?? IMAGE_DEFAULTS.thumbPx;
  const meta = await sharp(original).metadata();
  if (meta.format !== "jpeg" && meta.format !== "png") {
    throw new Error(`unsupported image format: ${meta.format ?? "unknown"}`);
  }
  // .rotate() with no argument applies EXIF orientation.
  const upright = sharp(original).rotate();
  const { data: rotated, info } = await upright.clone().toBuffer({ resolveWithObject: true });

  const [preview, thumb, phash, codes, capturedAt] = await Promise.all([
    sharp(rotated)
      .resize(previewPx, previewPx, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: IMAGE_DEFAULTS.previewQuality, mozjpeg: true })
      .toBuffer(),
    sharp(rotated)
      .resize(thumbPx, thumbPx, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: IMAGE_DEFAULTS.thumbQuality, mozjpeg: true })
      .toBuffer(),
    dHash(rotated),
    decodeCodes(rotated),
    readCapturedAt(original),
  ]);

  return {
    sha256: createHash("sha256").update(original).digest("hex"),
    phash,
    width: info.width,
    height: info.height,
    capturedAt,
    contentType: meta.format === "png" ? "image/png" : "image/jpeg",
    preview,
    thumb,
    codes,
  };
}

/** 64-bit difference hash as 16 hex chars: compares adjacent pixels of a 9x8 greyscale thumbnail. */
export async function dHash(image: Buffer): Promise<string> {
  const { data } = await sharp(image)
    .greyscale()
    .resize(9, 8, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = data[y * 9 + x]!;
      const right = data[y * 9 + x + 1]!;
      bits = (bits << 1n) | (left > right ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, "0");
}

export function hammingDistance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x > 0n) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/** Decode QR codes and barcodes. Tries the full image, then a downscaled copy. */
export async function decodeCodes(image: Buffer): Promise<DecodedCode[]> {
  ensureZxing();
  const seen = new Map<string, DecodedCode>();
  for (const maxPx of [2400, 1200]) {
    const { data, info } = await sharp(image)
      .resize(maxPx, maxPx, { fit: "inside", withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const results = await readBarcodes(
      { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height, colorSpace: "srgb" } as ImageData,
      { tryHarder: true, maxNumberOfSymbols: 8 },
    );
    for (const r of results) {
      if (r.isValid && r.text) seen.set(`${r.format}:${r.text}`, { format: r.format, text: r.text });
    }
    if (seen.size > 0) break;
  }
  return [...seen.values()];
}

async function readCapturedAt(original: Buffer): Promise<string | null> {
  try {
    const exif = await exifr.parse(original, ["DateTimeOriginal", "OffsetTimeOriginal"]);
    const date: unknown = exif?.DateTimeOriginal;
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  } catch {
    return null;
  }
}

export interface ContactTile {
  label: string;
  sublabel?: string;
  image: Buffer | null;
}

/**
 * Grid of up to 24 thumbnails, each labelled with its unit ID so Claude can name the match.
 * Tiles without an image show a grey placeholder.
 */
export async function contactSheet(tiles: ContactTile[], opts: { title?: string } = {}): Promise<Buffer> {
  const items = tiles.slice(0, IMAGE_DEFAULTS.contactSheetMaxTiles);
  const cell = 240;
  const labelH = 40;
  const gap = 8;
  const titleH = opts.title ? 36 : 0;
  const cols = Math.max(1, Math.min(6, items.length));
  const rows = Math.max(1, Math.ceil(items.length / cols));
  const width = cols * cell + (cols + 1) * gap;
  const height = titleH + rows * (cell + labelH) + (rows + 1) * gap;

  const composites: sharp.OverlayOptions[] = [];
  if (opts.title) {
    composites.push({ input: svgText(width, titleH, opts.title, 20, "start"), left: 0, top: 0 });
  }
  for (const [i, tile] of items.entries()) {
    const left = gap + (i % cols) * (cell + gap);
    const top = titleH + gap + Math.floor(i / cols) * (cell + labelH + gap);
    const img = tile.image
      ? await sharp(tile.image).resize(cell, cell, { fit: "contain", background: "#ffffff" }).jpeg().toBuffer()
      : await sharp({ create: { width: cell, height: cell, channels: 3, background: "#d8d4cc" } }).jpeg().toBuffer();
    composites.push({ input: img, left, top });
    const label = tile.sublabel ? `${tile.label} · ${tile.sublabel}` : tile.label;
    composites.push({ input: svgText(cell, labelH, label, 18, "middle"), left, top: top + cell });
  }

  return sharp({ create: { width, height, channels: 3, background: "#f7f4ee" } })
    .composite(composites)
    .jpeg({ quality: 80 })
    .toBuffer();
}

function svgText(width: number, height: number, text: string, size: number, anchor: "start" | "middle"): Buffer {
  const x = anchor === "middle" ? width / 2 : 10;
  const safe = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").slice(0, 60);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="100%" height="100%" fill="#161513"/>` +
      `<text x="${x}" y="${height / 2 + size / 3}" font-family="Menlo, Consolas, monospace" font-size="${size}" ` +
      `font-weight="bold" fill="#ffffff" text-anchor="${anchor}">${safe}</text></svg>`,
  );
}
