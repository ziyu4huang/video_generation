/**
 * Ambient types for tesseract-wasm — GLOBAL script (no top-level import/export),
 * pulled into EVERY program that typechecks `src/ocr/ocr.ts` via the triple-slash
 * reference directive at the top of that file (same mechanism as
 * `s2-agent-core-interface/src/index.ts`'s reference to `tool-gating.d.ts` —
 * directives inside the types-entry *library* are ignored, directives in a
 * program-graph module are processed).
 *
 * WHY: `tesseract-wasm@0.11.0` ships `dist/index.d.ts` but its exports map has
 * no `types` condition and `dist/lib.d.ts` does not exist, so `tsc` cannot
 * resolve the module from ANY program that imports it — file2md's own
 * typecheck AND the cross-package executor typecheck (tool-gate's
 * `migrated-extensions.ts`, movie-director, …). A package-local d.ts alone
 * only covers the package's own program; the reference directive makes it
 * part of every program that reaches ocr.ts.
 *
 * Surface: exactly what file2md uses, verified against upstream
 * `dist/ocr-engine.d.ts` (v0.11.0). If the package fixes its exports map,
 * delete this file + the reference directive once the typechecks are green
 * without them.
 */
declare module "tesseract-wasm" {
  /** Structural image-input shape the engine consumes (ImageData-like). */
  export interface OcrEngineImage {
    data: Uint8Array;
    width: number;
    height: number;
  }

  /** One text-recognition result item (per word/line box). */
  export interface TextItem {
    rect: { left: number; top: number; right: number; bottom: number };
    /** Combination of layout flags; unused by file2md. */
    flags: number;
    /** Confidence score for this word in [0, 1]. */
    confidence: number;
    text: string;
  }

  export class OCREngine {
    destroy(): void;
    loadModel(model: Uint8Array | ArrayBuffer): void;
    loadImage(image: OcrEngineImage): void;
    clearImage(): void;
    getText(onProgress?: (progress: number) => void): string;
    /** Layout analysis + text recognition; text boxes for a given unit ("line" | "word"). */
    getTextBoxes(unit: "line" | "word"): TextItem[];
  }

  export function createOCREngine(opts?: { wasmBinary?: Uint8Array; progressChannel?: unknown }): Promise<OCREngine>;
}
