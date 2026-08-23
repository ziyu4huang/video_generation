/**
 * image/decode-image.ts — image bytes → raw RGBA for the OCR engine.
 *
 * tesseract-wasm's low-level engine takes `{ data: RGBA, width, height }`;
 * decoded PNG/JPEG/BMP inputs land here. PNG via pngjs, JPEG via jpeg-js
 * (both pure JS — same family as the exceljs/jszip deps, no native code),
 * BMP via our own 24-bit decoder (`raster/rgba.ts`, round-trips the
 * encoder). Unsupported magic bytes degrade to `undefined` — the OCR
 * degrade-not-fail contract lives at the call site (never throws).
 */
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { bmpToRgba } from "../raster/rgba.ts";

export interface RgbaImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/** PNG/JPEG/BMP bytes → RGBA raw pixels; unsupported/undecodable → undefined. */
export function decodeImageToRgba(bytes: Uint8Array): RgbaImage | undefined {
  try {
    if (bytes.length < 8) return undefined;
    // BMP (24-bit bottom-up, our own encoder's shape): decode raw rows.
    // Dimensions come from the BMP header itself (width @18, height @22, LE).
    if (bytes[0] === 0x42 && bytes[1] === 0x4d && bytes.length >= 26) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const width = dv.getInt32(18, true);
      const height = Math.abs(dv.getInt32(22, true));
      if (width <= 0 || height <= 0) return undefined;
      return { data: bmpToRgba(bytes, width, height), width, height };
    }
    // PNG: pngjs handles interlace/palette/etc.
    if (bytes[0] === 0x89 && bytes[1] === 0x50) {
      const png = PNG.sync.read(Buffer.from(bytes));
      return { data: png.data, width: png.width, height: png.height };
    }
    // JPEG: jpeg-js decodes to RGBA row-major.
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      const { data, width, height } = jpeg.decode(Buffer.from(bytes), { useTArray: true, formatAsRGBA: true });
      return { data: new Uint8Array(data), width, height };
    }
    return undefined;
  } catch {
    return undefined;
  }
}
