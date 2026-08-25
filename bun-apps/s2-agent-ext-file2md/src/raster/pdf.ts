/**
 * raster/pdf.ts — bun-only PDF page rasterization via the pdfium wasm core
 * (@hyzyla/pdfium — pure wasm, no native code) + the pure-TS BMP encoder.
 *
 * Replaces v1's `src/native/pdf2png.ts` (pdf2image CLI → macOS PDFKit-in-
 * swift). The wasm binary is passed EXPLICITLY (read via src/assets.ts —
 * vendored/ in deploy, the npm package in dev): pdfium's default resolution
 * keys off its own package location, which does not exist once the JS is
 * bundled into ext.cjs (2026-08-25 layout change). The library is a lazy
 * singleton: `init()` is idempotent and every raster call degrades to
 * `undefined` when wasm init fails (callers turn that into an explicit
 * notice — never a throw).
 */
import { readFile } from "node:fs/promises";
import { PDFiumLibrary } from "@hyzyla/pdfium";
import { pdfiumWasmPath } from "../assets.ts";
import { bgraToBmp } from "./bmp.ts";

let library: Promise<PDFiumLibrary | undefined> | undefined;

/** Idempotent lazy init; resolves undefined when the wasm core fails to load. */
export function loadPdfium(): Promise<PDFiumLibrary | undefined> {
  if (library === undefined) {
    library = (async () => {
      const wasmPath = pdfiumWasmPath();
      const bytes = wasmPath !== undefined ? await readFile(wasmPath).catch(() => undefined) : undefined;
      // pdfium's typings want ArrayBuffer; new Uint8Array(buf) copies into a
      // fresh exact-size buffer, so .buffer is precisely the wasm image.
      const wasmBinary = bytes !== undefined ? new Uint8Array(bytes).buffer : undefined;
      return PDFiumLibrary.init(wasmBinary !== undefined ? { wasmBinary } : undefined);
    })().catch(() => undefined);
  }
  return library;
}

export interface RasterPageBmp {
  /** BMP bytes (24-bit, tesseract-grade). */
  bmp: Uint8Array;
  /** Raw BGRA pixels (4 bytes/px, top-down) — the PNG/VLM encode source. */
  bgra: Uint8Array;
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
    return { bmp: bgraToBmp(data, width, height), bgra: data, width, height };
  } catch {
    return undefined;
  }
}
