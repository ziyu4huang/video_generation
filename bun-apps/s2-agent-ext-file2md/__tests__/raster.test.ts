/**
 * raster.test.ts — the pure encoders + one REAL pdfium wasm raster (the
 * bun-only page-image stack, offline; no native code involved).
 */
import { describe, expect, test } from "bun:test";
import { imageDims } from "../src/ocr/ocr.ts";
import { bgraToBmp } from "../src/raster/bmp.ts";
import { loadPdfium, rasterPage } from "../src/raster/pdf.ts";
import { bgraToPng } from "../src/raster/png.ts";
import { scannedPdf } from "./helpers/docs.ts";

const W = 6;
const H = 4;
const BGRA = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H; i++) {
  BGRA[i * 4] = 10; // B
  BGRA[i * 4 + 1] = 20; // G
  BGRA[i * 4 + 2] = 30; // R
  BGRA[i * 4 + 3] = 255;
}

describe("pure encoders", () => {
  test("bgraToBmp writes a valid BMP header + dims round-trip via imageDims", () => {
    const bmp = bgraToBmp(BGRA, W, H);
    expect(bmp[0]).toBe(0x42);
    expect(bmp[1]).toBe(0x4d);
    const dims = imageDims(bmp);
    expect(dims).toEqual({ width: W, height: H });
  });

  test("bgraToPng writes a valid PNG signature + IHDR dims round-trip", () => {
    const png = bgraToPng(BGRA, W, H);
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const dims = imageDims(png);
    expect(dims).toEqual({ width: W, height: H });
  });

  test("pdf-lib accepts our encoder's PNG (embedPng decodes it)", async () => {
    const png = bgraToPng(BGRA, W, H);
    const img = await import("pdf-lib");
    const doc = await img.PDFDocument.create();
    await expect(doc.embedPng(png)).resolves.toBeDefined();
  });
});

describe("pdfium wasm raster (real, offline)", () => {
  test("rasterPage returns a bitmap with sane dims for a scanned-shape PDF", async () => {
    const pdf = await scannedPdf();
    const lib = await loadPdfium();
    expect(lib).toBeDefined();
    const page = await rasterPage(pdf, 1, 2);
    expect(page).toBeDefined();
    expect(page?.width).toBeGreaterThan(0);
    expect(page?.height).toBeGreaterThan(0);
    const bmpDims = imageDims(page?.bmp);
    expect(bmpDims).toEqual({ width: page?.width, height: page?.height });
  }, 30_000);

  test("rasterPage is stable across repeated calls (singleton reuse)", async () => {
    const pdf = await scannedPdf();
    const a = await rasterPage(pdf, 1, 2);
    const b = await rasterPage(pdf, 1, 2);
    expect(a?.width).toBe(b?.width);
  }, 30_000);
});
