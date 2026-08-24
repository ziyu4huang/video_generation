/**
 * ocr.test.ts — pure parts of the OCR module (dims parsing, lang mapping);
 * the real tesseract engine (wasm + npm lang data) is exercised by
 * ocr-engine.test.ts, not here.
 */
import { describe, expect, test } from "bun:test";
import { imageDims, normalizeOcrLang } from "../src/ocr/ocr.ts";

describe("normalizeOcrLang", () => {
  test("maps aliases to vendored ids and dedupes", () => {
    expect(normalizeOcrLang("en")).toBe("eng");
    expect(normalizeOcrLang("en+chi_sim")).toBe("eng+chi_sim");
    expect(normalizeOcrLang("zh")).toBe("chi_sim");
    expect(normalizeOcrLang("eng+en+chi_sim")).toBe("eng+chi_sim");
  });
  test("unknown langs fall back to eng", () => {
    expect(normalizeOcrLang("jpn")).toBe("eng");
    expect(normalizeOcrLang("")).toBe("eng");
    expect(normalizeOcrLang()).toBe("eng");
  });
});

describe("imageDims (header-only parsing, no decode)", () => {
  test("PNG IHDR", () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47], 0);
    png[16] = 0;
    png[17] = 0;
    png[18] = 1;
    png[19] = 0; // 256
    png[20] = 0;
    png[21] = 0;
    png[22] = 0;
    png[23] = 64; // 64
    expect(imageDims(png)).toEqual({ width: 256, height: 64 });
  });
  test("JPEG SOF0", () => {
    // ff d8 ff e0 <len 16> ffd8 ... ff c0 <len> <h> <w> ...
    const jpg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
      0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x80, 0x01, 0x00, 0x03, 0x01, 0x22,
    ]);
    expect(imageDims(jpg)).toEqual({ width: 256, height: 128 });
  });
  test("BMP header", () => {
    const bmp = new Uint8Array(26);
    bmp.set([0x42, 0x4d], 0);
    new DataView(bmp.buffer).setInt32(18, 320, true);
    new DataView(bmp.buffer).setInt32(22, 240, true);
    expect(imageDims(bmp)).toEqual({ width: 320, height: 240 });
  });
  test("unknown → undefined", () => {
    expect(imageDims(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});
