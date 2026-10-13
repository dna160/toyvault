import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import QRCode from "qrcode";
import sharp from "sharp";

/** A synthetic "toy box" photo: coloured background, big label text, optional QR sticker. */
export async function toyPhoto(opts: { color: string; label: string; qr?: string; shift?: number; rotateExif?: boolean }) {
  const width = 1600;
  const height = 1200;
  const shift = opts.shift ?? 0;
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
       <rect width="100%" height="100%" fill="${opts.color}"/>
       <rect x="${200 + shift}" y="200" width="900" height="700" fill="#ffffff" opacity="0.85"/>
       <circle cx="${1300 + shift}" cy="300" r="140" fill="#222222"/>
       <text x="${260 + shift}" y="560" font-family="Helvetica, Arial" font-size="110" font-weight="bold" fill="#111">${opts.label}</text>
     </svg>`,
  );
  const composites: sharp.OverlayOptions[] = [{ input: svg, left: 0, top: 0 }];
  if (opts.qr) {
    const qr = await QRCode.toBuffer(opts.qr, { width: 320, margin: 2 });
    composites.push({ input: qr, left: 1180, top: 760 });
  }
  let img = sharp({ create: { width, height, channels: 3, background: "#ffffff" } }).composite(composites).jpeg({ quality: 90 });
  if (opts.rotateExif) img = img.withMetadata({ orientation: 6 });
  return img.toBuffer();
}

export function writeInbox(root: string, folder: string, files: Record<string, Buffer>) {
  const dir = join(root, "inbox", folder);
  mkdirSync(dir, { recursive: true });
  for (const [name, buf] of Object.entries(files)) writeFileSync(join(dir, name), buf);
}
