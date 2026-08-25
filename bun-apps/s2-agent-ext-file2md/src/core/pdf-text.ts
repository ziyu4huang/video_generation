/**
 * core/pdf-text.ts — pure-TS PDF text-layer extraction (pdfjs-dist legacy,
 * worker-free on the main thread — the DSH Cowork pattern).
 *
 * Replaces v1's mupdf-based `src/native/pdftext.ts` with a zero-native
 * dependency. One open gives page count + lazy per-page text, so the pipeline
 * can interleave text extraction with selective rasterization (scanned pages).
 */
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { pdfjsAssetDirUrl } from "../assets.ts";

export interface PdfHandle {
  numPages: number;
  /** Extracted text of a 1-indexed page (positional join, word-boundary aware). */
  getText(page: number): Promise<string>;
  destroy(): Promise<void>;
}

/**
 * pdfjs's external asset dirs, resolved once per process (vendored/ in deploy,
 * the npm package in dev — see src/assets.ts). Passed as plain absolute paths
 * with a trailing separator: on Node/Bun pdfjs reads them through
 * NodeBinaryDataFactory (fs.readFile of `${url}${name}`), so no file:// form.
 * Only the params whose dir exists are set — text extraction needs none of
 * them; cmaps/standard_fonts/wasm matter for CJK text, non-embedded fonts,
 * and JBIG2/JPX image decoding respectively.
 */
const pdfjsAssetParams = (() => {
  const params: {
    cMapUrl?: string;
    cMapPacked?: boolean;
    standardFontDataUrl?: string;
    wasmUrl?: string;
    iccUrl?: string;
  } = {};
  const cmaps = pdfjsAssetDirUrl("cmaps");
  if (cmaps !== undefined) {
    params.cMapUrl = cmaps;
    params.cMapPacked = true;
  }
  const fonts = pdfjsAssetDirUrl("standard_fonts");
  if (fonts !== undefined) params.standardFontDataUrl = fonts;
  const wasm = pdfjsAssetDirUrl("wasm");
  if (wasm !== undefined) params.wasmUrl = wasm;
  const iccs = pdfjsAssetDirUrl("iccs");
  if (iccs !== undefined) params.iccUrl = iccs; // worker appends CGATS001Compat-v2-micro.icc
  return params;
})();

/** Collapse pdfjs text items into one line of text per page. */
function pageText(items: Array<{ str?: string; hasEOL?: boolean }>): string {
  let out = "";
  for (const item of items) {
    out += item.str ?? "";
    if (item.hasEOL) out += "\n";
  }
  // The layout of getTextContent is positional, not grammatical; joining with
  // spaces preserves word boundaries better than raw concatenation.
  return out.replace(/[ \t]+\n/g, "\n").trim();
}

/** Open a PDF buffer for text extraction. Throws DocError-ish on parse failure. */
export async function openPdf(data: Uint8Array): Promise<PdfHandle> {
  const task = getDocument({ data: data.slice().buffer as ArrayBuffer, ...pdfjsAssetParams });
  const doc = await task.promise;
  return {
    numPages: doc.numPages,
    async getText(page: number): Promise<string> {
      const p = await doc.getPage(page);
      try {
        const content = await p.getTextContent();
        return pageText(content.items as Array<{ str?: string; hasEOL?: boolean }>);
      } finally {
        p.cleanup();
      }
    },
    async destroy(): Promise<void> {
      await task.destroy();
    },
  };
}
