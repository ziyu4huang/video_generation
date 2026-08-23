/**
 * raster/rgba.ts — pure-TS BGRA/BMP → RGBA conversion for the OCR engine.
 *
 * tesseract-wasm's low-level engine consumes `{ data: RGBA, width, height }`
 * — pdfium renders BGRA and our own encoders produce BMP, so both cross the
 * gap here. No deps, no zlib — pure byte moves (the BMP path mirrors the
 * 24-bit bottom-up shape of `bgraToBmp` exactly).
 */

/** BGRA → RGBA (channel swap B↔R; alpha passed through). */
export function bgraToRgba(bgra: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * 4;
    const d = i * 4;
    out[d] = bgra[s + 2]!; // R
    out[d + 1] = bgra[s + 1]!; // G
    out[d + 2] = bgra[s]!; // B
    out[d + 3] = bgra[s + 3]!; // A
  }
  return out;
}

/**
 * 24-bit bottom-up BMP (the shape `bgraToBmp` writes) → RGBA.
 * Caller passes width/height; row stride is recomputed per the BMP 4-byte
 * alignment rule. Bottom-up rows: source row 0 (of the raster) is the LAST
 * image row, so decode writes it flipped (same as the encoder's flip).
 */
export function bmpToRgba(bmp: Uint8Array, width: number, height: number): Uint8Array {
  const rowBytes = width * 3;
  const stride = rowBytes + ((4 - (rowBytes % 4)) % 4);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcRow = 54 + y * stride;
    const dstRow = (height - 1 - y) * width * 4;
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * 3;
      const d = dstRow + x * 4;
      out[d] = bmp[s + 2]!; // R
      out[d + 1] = bmp[s + 1]!; // G
      out[d + 2] = bmp[s]!; // B
      out[d + 3] = 255; // BMP has no alpha
    }
  }
  return out;
}
