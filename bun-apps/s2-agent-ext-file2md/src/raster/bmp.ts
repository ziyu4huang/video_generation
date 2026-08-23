/**
 * raster/bmp.ts — pure-TS BGRA → 24-bit BMP encoder (no deps, no zlib).
 *
 * pdfium renders pages as BGRA pixel buffers; the OCR engine consumes
 * raw RGBA (decoded in src/raster/rgba.ts), so pages cross the gap as BMP —
 * the simplest encodable raster format (no CRC, no deflate).
 */

/** Encode a BGRA byte buffer as an uncompressed 24-bit BMP (bottom-up rows). */
export function bgraToBmp(bgra: Uint8Array, width: number, height: number): Uint8Array {
  const rowBytes = width * 3;
  const stride = rowBytes + ((4 - (rowBytes % 4)) % 4);
  const dataSize = stride * height;
  const out = new Uint8Array(14 + 40 + dataSize);
  const dv = new DataView(out.buffer);
  // BITMAPFILEHEADER
  out[0] = 0x42;
  out[1] = 0x4d;
  dv.setUint32(2, out.length, true);
  dv.setUint32(10, 14 + 40, true);
  // BITMAPINFOHEADER
  dv.setUint32(14, 40, true);
  dv.setInt32(18, width, true);
  dv.setInt32(22, height, true);
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  dv.setUint32(34, dataSize, true);
  dv.setInt32(38, 2835, true);
  dv.setInt32(42, 2835, true);
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width * 4;
    const dstRow = 54 + y * stride;
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 3;
      out[d] = bgra[s]!;
      out[d + 1] = bgra[s + 1]!;
      out[d + 2] = bgra[s + 2]!;
    }
  }
  return out;
}
