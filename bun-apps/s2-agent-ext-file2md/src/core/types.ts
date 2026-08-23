/**
 * core/types.ts — the v2 file2md type surface.
 *
 * v2 is "text-first, bun-only": every document kind resolves to a bounded
 * structured read (the vendored dsh-cowork-core windowing contract), which
 * renders to Markdown. Vision (LM Studio) and OCR (vendored tesseract wasm)
 * are optional enhancements layered on `text`-kind reads.
 */

/** Mechanical file kind — the sniff result. */
export type FileKind = "pdf" | "image" | "docx" | "xlsx" | "pptx" | "ipynb" | "text";

/** Which extraction levels the pipeline runs (replaces v1's extract strategies). */
export type File2mdMode = "auto" | "text" | "ocr" | "vlm" | "smart";

/** VLM page-note style (v1 `mode`; renamed so `mode` can mean the pipeline). */
export type PageNoteStyle = "summary" | "verbatim" | "hybrid";

/** Text passthrough subtype (txt/md are literal; csv/html are lightly converted). */
export type TextInKind = "txt" | "md" | "csv" | "html";

export interface SniffedFile {
  kind: FileKind;
  /** Subtype for kind === "text". */
  textKind?: TextInKind;
  /** True when the format was disambiguated by content, not extension. */
  byContent?: boolean;
}

/** Caps mirrored from DSH Cowork core (vendored, defaults below). */
export interface File2mdCaps {
  maxInputBytes: number;
  maxDecompressedBytes: number;
  maxZipEntries: number;
  maxBytes: number;
  maxPages: number;
  maxSheetRows: number;
  maxSheets: number;
  maxSlides: number;
  maxCells: number;
  /** Hard cap on pages OCR'd for one document (scan-heavy PDFs). */
  ocrPages: number;
}

export const DEFAULT_CAPS: File2mdCaps = {
  maxInputBytes: 64 * 1024 * 1024,
  maxDecompressedBytes: 512 * 1024 * 1024,
  maxZipEntries: 4096,
  maxBytes: 256 * 1024,
  maxPages: 20,
  maxSheetRows: 200,
  maxSheets: 1,
  maxSlides: 20,
  maxCells: 200,
  ocrPages: 20,
};

/** Options passed to the v2 pipeline (mirrors the file2md tool args). */
export interface File2mdPipelineOptions {
  inputs: string[];
  outRoot: string;
  /** auto (text → OCR → optional vision) | text | ocr | vlm. Default "auto". */
  mode?: File2mdMode;
  /** VLM note style for pdf/image pages (ignored unless the vision layer runs). */
  note?: PageNoteStyle;
  /** Pdfium render scale for page images (default 2 ≈ 144 dpi). */
  scale?: number;
  /** Ocr language: "en" | "chi_sim" | "en+chi_sim". Default "en". */
  lang?: string;
  /** 1-indexed page selection, e.g. "1-3" / "3,5" / "1,3-5,8". */
  pages?: string;
  /** Explicit VLM model (provider/id). Defaults to the vision tier config. */
  model?: string;
  provider?: string;
  thinking?: string;
  /** Force the semantic doc profile (paper|slides|poster|diagram|image). */
  forcedType?: string;
  /** Display paths relative to cwd when true. Default false (absolute). */
  relpath?: boolean;
  /** Max concurrent page extractions (VLM path only; default 1). */
  concurrency?: number;
  /** Optional NDJSON emit (json mode). */
  emit?: (obj: unknown) => void;
}

/** Provenance of a page's text in the rendered markdown. */
export type PageProvenance = "text" | "ocr" | "vision";
