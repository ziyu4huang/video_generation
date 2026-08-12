/**
 * pdftext.ts — PDF text-layer extraction via mupdf (Bun/WASM).
 *
 * Mirrors pdf2png.ts's role for text: given a born-digital PDF, return each
 * page's text without rasterizing or calling a VLM. mupdf's StructuredText
 * reconstructs reading order + spacing; figures (vector or raster) are NOT
 * captured here — that is the VLM's job in `hybrid` mode.
 *
 * mupdf API (verified): `Document.openDocument(Buffer)` → `loadPage(i)`
 * → `toStructuredText().asText()`. Pass a Node `Buffer` (from `readFileSync`),
 * NOT a `Uint8Array` (→ "invalid pointer"). Do NOT use `Document.open`
 * (undefined) or `page.toText` (undefined).
 */
import { readFileSync } from "node:fs";
// MUST stay above the `mupdf` import: it sets globalThis.$libmupdf_wasm_Module,
// which mupdf's emscripten glue reads during its own top-level await. ESM
// evaluates imports in source order, so this is what makes a bundled/compiled
// build find mupdf-wasm.wasm at all. See mupdf-wasm-locate.ts.
import "./mupdf-wasm-locate.ts";
import * as mupdf from "mupdf";

export interface ExtractedPageText {
  pageNo: number;
  text: string;
}

export interface ExtractPdfTextOpts {
  /** 1-indexed page numbers to extract; omit for all. */
  pages?: Set<number>;
}

export interface ExtractPdfTextResult {
  pageCount: number;
  pages: ExtractedPageText[];
}

/**
 * Extract the embedded text layer of a (born-digital) PDF.
 *
 * @param pdfPath  absolute path to the source PDF
 * @param opts.pages  optional 1-indexed page filter; omit to extract every page
 * @returns total page count + the extracted text for each requested page
 */
export function extractPdfText(pdfPath: string, opts: ExtractPdfTextOpts = {}): ExtractPdfTextResult {
  // readFileSync returns a Node Buffer; mupdf rejects a bare Uint8Array with
  // "invalid pointer", so we must not coerce it away.
  const doc = mupdf.Document.openDocument(readFileSync(pdfPath));
  const pageCount = doc.countPages();
  const only = opts.pages;
  const pages: ExtractedPageText[] = [];
  for (let i = 0; i < pageCount; i++) {
    const pageNo = i + 1;
    if (only && !only.has(pageNo)) continue;
    pages.push({
      pageNo,
      text: doc.loadPage(i).toStructuredText().asText(),
    });
  }
  return { pageCount, pages };
}
