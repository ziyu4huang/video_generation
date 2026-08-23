/**
 * Ambient types for tesseract-wasm (pinned ^0.11.0, BSD-2-Clause).
 *
 * The package ships no `types` condition in its exports map
 * (`.` → `./dist/lib.js`, `./node` → `./src/node-worker.js`) and the
 * sibling declaration files are not what NodeNext resolution expects, so
 * tsc cannot follow it. We declare exactly the surface file2md uses,
 * verified against upstream `dist/ocr-engine.d.ts` (v0.11.0). If the
 * package fixes its types, this file can be deleted with a typecheck green.
 */
declare module "tesseract-wasm" {
  /** Structural image-input shape the engine consumes (ImageData-like). */
  export interface OcrEngineImage {
    data: Uint8Array;
    width: number;
    height: number;
  }

  export class OCREngine {
    destroy(): void;
    loadModel(model: Uint8Array | ArrayBuffer): void;
    loadImage(image: OcrEngineImage): void;
    clearImage(): void;
    getText(onProgress?: (progress: number) => void): string;
  }

  export function createOCREngine(opts?: { wasmBinary?: Uint8Array; progressChannel?: unknown }): Promise<OCREngine>;
}

declare module "tesseract-wasm/node" {
  /** Read the bundled wasm binary from the package's dist (offline). */
  export function loadWasmBinary(): Promise<Uint8Array>;
}
