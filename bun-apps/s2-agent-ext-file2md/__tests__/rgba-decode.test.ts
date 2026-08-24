/**
 * rgba-decode.test.ts — the RGBA decode layer behind the tesseract-wasm swap.
 *
 * The new OCR engine consumes raw RGBA pixels (`{ data, width, height }`), so
 * every page/image must land in RGBA before OCR: pdfium gives BGRA (channel
 * swap), BMP gives 24-bit bottom-up rows (row decode), PNG/JPEG go through
 * pngjs/jpeg-js (pure JS decoders, same family as the exceljs/jszip deps).
 * Round-trips use OUR OWN encoders (bgraToBmp/bgraToPng) as fixtures — the
 * same self-verifying-fixture pattern as helpers/docs.ts.
 */
import { describe, expect, test } from "bun:test";
import jpeg from "jpeg-js";
import { decodeImageToRgba } from "../src/image/decode-image.ts";
import { bgraToBmp } from "../src/raster/bmp.ts";
import { bgraToPng } from "../src/raster/png.ts";
import { bgraToRgba, bmpToRgba } from "../src/raster/rgba.ts";

/** Deterministic 3-row × 2-col BGRA pattern (distinct channels per pixel). */
function sampleBgra(): { bgra: Uint8Array; rgba: Uint8Array; width: number; height: number } {
  const width = 2;
  const height = 3;
  const bgra = new Uint8Array(width * height * 4);
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    bgra[i * 4] = i * 13 + 1; // B
    bgra[i * 4 + 1] = i * 29 + 2; // G
    bgra[i * 4 + 2] = i * 47 + 3; // R
    bgra[i * 4 + 3] = 255;
    rgba[i * 4] = bgra[i * 4 + 2]; // R
    rgba[i * 4 + 1] = bgra[i * 4 + 1]; // G
    rgba[i * 4 + 2] = bgra[i * 4]; // B
    rgba[i * 4 + 3] = bgra[i * 4 + 3]; // A
  }
  return { bgra, rgba, width, height };
}

describe("bgraToRgba", () => {
  test("swaps B/R bytes in place order, keeps A", () => {
    const { bgra, rgba, width, height } = sampleBgra();
    expect(bgraToRgba(bgra, width, height)).toEqual(rgba);
  });
});

describe("bmpToRgba (24-bit bottom-up BMP)", () => {
  test("round-trips OUR OWN bgraToBmp encoder", () => {
    const { bgra, width, height } = sampleBgra();
    const bmp = bgraToBmp(bgra, width, height);
    const decoded = bmpToRgba(bmp, width, height);
    expect(decoded).toEqual(bgraToRgba(bgra, width, height));
  });
});

describe("decodeImageToRgba", () => {
  test("BMP (own encoder) → RGBA", () => {
    const { bgra, rgba, width, height } = sampleBgra();
    const out = decodeImageToRgba(bgraToBmp(bgra, width, height));
    expect(out?.width).toBe(width);
    expect(out?.height).toBe(height);
    expect(out?.data).toEqual(rgba);
  });

  test("PNG (own encoder, filter-0) → RGBA", () => {
    const { bgra, rgba, width, height } = sampleBgra();
    const out = decodeImageToRgba(bgraToPng(bgra, width, height));
    expect(out?.width).toBe(width);
    expect(out?.height).toBe(height);
    expect(out?.data).toEqual(rgba);
  });

  test("JPEG (jpeg-js encode) → RGBA float-round-trip (lossy: dims exact, pixels within 16/255)", () => {
    const { bgra, width, height } = sampleBgra();
    const jpg = jpeg.encode({ data: bgraToRgba(bgra, width, height), width, height }, 90).data;
    const out = decodeImageToRgba(new Uint8Array(jpg));
    expect(out?.width).toBe(width);
    expect(out?.height).toBe(height);
    const exp = bgraToRgba(bgra, width, height);
    for (let i = 0; i < exp.length; i++) {
      expect(Math.abs((out?.data[i] ?? 255) - exp[i])).toBeLessThan(16);
    }
  });

  test("unsupported bytes (GIF magic) degrade to undefined — never throws", () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
    expect(decodeImageToRgba(gif)).toBeUndefined();
  });
});
