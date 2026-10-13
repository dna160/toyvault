import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { contactSheet, dHash, hammingDistance, processPhoto } from "../src/images.js";
import { toyPhoto } from "./fixtures.js";

describe("image helpers", () => {
  it("decodes a QR label on a photo", async () => {
    const photo = await processPhoto(await toyPhoto({ color: "#2a6fdb", label: "RACER", qr: "TV-004871" }));
    expect(photo.codes).toContainEqual({ format: "QRCode", text: "TV-004871" });
  });

  it("produces bounded previews and thumbnails and a stable SHA-256", async () => {
    const buf = await toyPhoto({ color: "#cc3333", label: "PLUSH" });
    const a = await processPhoto(buf);
    const b = await processPhoto(buf);
    expect(a.sha256).toBe(b.sha256);
    const preview = await sharp(a.preview).metadata();
    const thumb = await sharp(a.thumb).metadata();
    expect(Math.max(preview.width!, preview.height!)).toBe(1024);
    expect(Math.max(thumb.width!, thumb.height!)).toBe(256);
    expect(a.contentType).toBe("image/jpeg");
  });

  it("applies EXIF orientation", async () => {
    const photo = await processPhoto(await toyPhoto({ color: "#33aa55", label: "KIT", rotateExif: true }));
    expect(photo.width).toBe(1200);
    expect(photo.height).toBe(1600);
  });

  it("keeps near-identical shots close and different toys far apart in dHash", async () => {
    const base = await dHash(await toyPhoto({ color: "#2a6fdb", label: "RACER" }));
    const same = await dHash(await sharp(await toyPhoto({ color: "#2a6fdb", label: "RACER" })).jpeg({ quality: 60 }).toBuffer());
    const other = await dHash(await toyPhoto({ color: "#f0c419", label: "DOLL", shift: 300 }));
    expect(hammingDistance(base, same)).toBeLessThanOrEqual(4);
    expect(hammingDistance(base, other)).toBeGreaterThan(12);
  });

  it("rejects formats other than JPEG and PNG", async () => {
    const webp = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).webp().toBuffer();
    await expect(processPhoto(webp)).rejects.toThrow(/unsupported image format/);
  });

  it("builds a labelled contact sheet", async () => {
    const thumb = (await processPhoto(await toyPhoto({ color: "#2a6fdb", label: "A" }))).thumb;
    const sheet = await contactSheet(
      [
        { label: "TV-000001", image: thumb },
        { label: "TV-000002", image: null },
        { label: "TV-000003", image: thumb },
      ],
      { title: "At source" },
    );
    const meta = await sharp(sheet).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBeGreaterThan(700);
  });
});
