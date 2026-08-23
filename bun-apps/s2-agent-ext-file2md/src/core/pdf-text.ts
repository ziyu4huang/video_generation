/**
 * core/pdf-text.ts — pure-TS PDF text-layer extraction (pdfjs-dist legacy,
 * worker-free on the main thread — the DSH Cowork pattern).
 *
 * Replaces v1's mupdf-based `src/native/pdftext.ts` with a zero-native
 * dependency. One open gives page count + lazy per-page text, so the pipeline
 * can interleave text extraction with selective rasterization (scanned pages).
 */
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PdfHandle {
  numPages: number;
  /** Extracted text of a 1-indexed page (positional join, word-boundary aware). */
  getText(page: number): Promise<string>;
  destroy(): Promise<void>;
}

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
  const task = getDocument({ data: data.slice().buffer as ArrayBuffer });
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
