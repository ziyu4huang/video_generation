/**
 * raster/pdf.ts — bun-only PDF page rasterization via vendored pdfium wasm
 * (@hyzyla/pdfium — pure wasm, no native code) + the pure-TS BMP encoder.
 *
 * Replaces v1's `src/native/pdf2png.ts` (pdf2image CLI → macOS PDFKit-in-
 * swift). The pdfium library is a lazy singleton: `init()` is idempotent and
 * every raster call degrades to `undefined` when wasm init fails (callers
 * turn that into an explicit notice — never a throw).
 */
import { PDFiumLibrary } from "@hyzyla/pdfium";
import { bgraToBmp } from "./bmp.ts";

let library: Promise<PDFiumLibrary | undefined> | undefined;

/** Idempotent lazy init; resolves undefined when the wasm core fails to load. */
export function loadPdfium(): Promise<PDFiumLibrary | undefined> {
  if (library === undefined) {
    library = PDFiumLibrary.init()
      .then((lib) => lib)
      .catch(() => undefined);
  }
  return library;
}

export interface RasterPageBmp {
  /** BMP bytes (24-bit, tesseract-grade). */
  bmp: Uint8Array;
  width: number;
  height: number;
}

/** Rasterize one 1-indexed page of a PDF buffer to a BMP bitmap (degradable). */
export async function rasterPage(pdf: Uint8Array, page: number, scale: number): Promise<RasterPageBmp | undefined> {
  const lib = await loadPdfium();
  if (lib === undefined) return undefined;
  try {
    const doc = await lib.loadDocument(pdf);
    const pdfPage = doc.getPage(page - 1);
    const { width, height, data } = await pdfPage.render({ scale });
    return { bmp: bgraToBmp(data, width, height), width, height };
  } catch {
    return undefined;
  }
}
