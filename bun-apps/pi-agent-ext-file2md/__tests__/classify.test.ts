/**
 * kind/mime classifiers.
 *
 * imageMimeType is pure. classifyKind sniffs real magic bytes, so it uses tiny
 * fixture buffers in a temp dir (no real documents).
 *
 *   bun test __tests__/classify.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyKind, imageMimeType } from "../src/vlm/classify.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pivlm-cls-"));
  // Real magic-byte prefixes (only the head matters; sniffKind reads 16 bytes).
  await writeFile(join(dir, "doc.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x35]));
  await writeFile(join(dir, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await writeFile(join(dir, "img.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  await writeFile(join(dir, "img.gif"), Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]));
  // Non-magic bytes but a .pdf extension → extension fallback
  await writeFile(join(dir, "fake.pdf"), Buffer.from([0x00, 0x00, 0x00, 0x00]));
  // Genuinely unsupported
  await writeFile(join(dir, "blob.xyz"), Buffer.from([0x01, 0x02, 0x03, 0x04]));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("imageMimeType", () => {
  test("pdf → image/png (we always rasterize to png)", () => {
    expect(imageMimeType({ kind: "pdf", path: "x.pdf" })).toBe("image/png");
  });

  test("each image extension maps to the right mime", () => {
    expect(imageMimeType({ kind: "image", path: "a.png" })).toBe("image/png");
    expect(imageMimeType({ kind: "image", path: "a.jpg" })).toBe("image/jpeg");
    expect(imageMimeType({ kind: "image", path: "a.jpeg" })).toBe("image/jpeg");
    expect(imageMimeType({ kind: "image", path: "a.webp" })).toBe("image/webp");
    expect(imageMimeType({ kind: "image", path: "a.gif" })).toBe("image/gif");
    expect(imageMimeType({ kind: "image", path: "a.bmp" })).toBe("image/bmp");
    expect(imageMimeType({ kind: "image", path: "a.tiff" })).toBe("image/tiff");
    expect(imageMimeType({ kind: "image", path: "a.tif" })).toBe("image/tiff");
  });

  test("unknown extension defaults to png; case-insensitive on the ext", () => {
    expect(imageMimeType({ kind: "image", path: "a.xyz" })).toBe("image/png");
    expect(imageMimeType({ kind: "image", path: "A.JPG" })).toBe("image/jpeg");
  });
});

describe("classifyKind", () => {
  test("PDF magic bytes → pdf", () => {
    expect(classifyKind(join(dir, "doc.pdf")).kind).toBe("pdf");
  });

  test("PNG / JPEG / GIF magic bytes → image", () => {
    expect(classifyKind(join(dir, "img.png")).kind).toBe("image");
    expect(classifyKind(join(dir, "img.jpg")).kind).toBe("image");
    expect(classifyKind(join(dir, "img.gif")).kind).toBe("image");
  });

  test("falls back to extension when magic bytes don't match", () => {
    // fake.pdf starts with 0x00 0x00... (not %PDF) but the .pdf ext wins.
    expect(classifyKind(join(dir, "fake.pdf")).kind).toBe("pdf");
  });

  test("unsupported file → throws", () => {
    expect(() => classifyKind(join(dir, "blob.xyz"))).toThrow(/Unsupported/);
  });

  test("missing file → throws", () => {
    expect(() => classifyKind(join(dir, "nope.pdf"))).toThrow(/Input not found/);
  });

  test("result carries the absolute path + basename name", () => {
    const r = classifyKind(join(dir, "doc.pdf"));
    expect(r.path).toBe(join(dir, "doc.pdf"));
    expect(r.name).toBe("doc.pdf");
  });
});
