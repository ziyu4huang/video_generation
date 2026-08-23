/// <reference path="./tesseract-wasm.d.ts" />
/**
 * ocr/ocr.ts — local OCR via tesseract-wasm (robertknight, bun-only, offline).
 *
 * Replaces v1's macOS-Vision Swift CLI and v2's tesseract.js worker: the
 * in-process low-level `OCREngine` (no worker_threads, no runtime network —
 * the wasm core + lang data come off disk). Lang data (eng/chi_sim,
 * tessdata_fast) is vendored beside the package as raw `.traineddata`
 * symlinks into the external binary store. Every failure degrades to
 * `undefined` with an explicit stderr note (never throws), mirroring v1's
 * degrade-not-fail contract. Heremes-memory consumes `OcrResult`.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOCREngine, type OCREngine } from "tesseract-wasm";
import { decodeImageToRgba } from "../image/decode-image.ts";
import { rasterPage } from "../raster/pdf.ts";

/** One OCR run's result — same shape as v1's swift-OCR contract (hermes-memory consumes this type). */
export interface OcrResult {
  text: string;
  width: number;
  height: number;
  format: string;
}

const PKG_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Engine-default language dir — vendored asset, resolved beside the package. */
export const DEFAULT_LANG_PATH = join(PKG_ROOT, "vendored", "ocr-assets", "lang");

/**
 * The wasm core's path in the npm package dist. Resolved here — NOT via the
 * package's `node` subpath, which is the worker_threads adapter we
 * deliberately do not use.
 */
const WASM_BINARY_PATH = fileURLToPath(
  new URL("../../node_modules/tesseract-wasm/dist/tesseract-core.wasm", import.meta.url),
);

/** Read the wasm core off disk (cached per process). Degrades cleanly on failure. */
async function loadWasmBinary(): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(WASM_BINARY_PATH));
  } catch {
    return undefined;
  }
}

/** wasm binary cache (1.8 MB fs read — load once per process). */
let wasmBinaryCache: Uint8Array | undefined;

/** Normalize "en+chi_sim" etc.; only ship what we vendored. */
export function normalizeOcrLang(lang: string | undefined): string {
  const parts = (lang ?? "en")
    .split("+")
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l === "eng" || l === "chi_sim" || l === "en" || l === "zh" || l === "zh_cn");
  const mapped = parts.map((l) =>
    l === "eng" ? "eng" : l === "en" ? "eng" : l === "chi_sim" || l === "zh_cn" || l === "zh" ? "chi_sim" : l,
  );
  const unique = [...new Set(mapped)];
  return unique.length > 0 ? unique.join("+") : "eng";
}

/**
 * Reusable per-document OCR session: one engine, many pages, then terminate.
 * Capable of PNG/JPEG/BMP buffers — raw pages cross as BMP via the raster
 * layer, everything else via the image decoders (`decodeImageToRgba`).
 */
export class OcrSession {
  private engine: OCREngine | undefined;
  private lang: string;
  private langPath: string;
  constructor(lang: string, langPath = DEFAULT_LANG_PATH) {
    // Engine models are raw `lang.traineddata` files — normalize aliases
    // here so a caller passing "en" gets the vendored "eng" file, not ENOENT.
    this.lang = normalizeOcrLang(lang);
    this.langPath = langPath;
  }

  async init(): Promise<boolean> {
    if (this.engine !== undefined) return true;
    try {
      if (wasmBinaryCache === undefined) {
        wasmBinaryCache = await loadWasmBinary();
        if (wasmBinaryCache === undefined) throw new Error(`wasm core not found at ${WASM_BINARY_PATH}`);
      }
      const engine = await createOCREngine({ wasmBinary: wasmBinaryCache });
      // Load one raw `.traineddata` per lang part ("eng+chi_sim" → 2 loads).
      let loaded = false;
      for (const part of this.lang.split("+")) {
        const model = readFileSync(join(this.langPath, `${part}.traineddata`));
        engine.loadModel(model);
        loaded = true;
      }
      if (!loaded) throw new Error(`no model loaded for "${this.lang}"`);
      this.engine = engine;
      return true;
    } catch (e) {
      process.stderr.write(`[file2md] tesseract-wasm init failed: ${e instanceof Error ? e.message : String(e)}\n`);
      this.engine = undefined;
      return false;
    }
  }

  /** OCR one encoded image (PNG/JPEG/BMP) → RGBA → sync engine. */
  async recognize(data: Uint8Array): Promise<OcrResult | undefined> {
    if (this.engine === undefined && !(await this.init())) return undefined;
    try {
      const img = decodeImageToRgba(data);
      if (img === undefined) return undefined;
      this.engine?.loadImage(img);
      const text = (this.engine?.getText() ?? "").trim();
      if (text === "") return undefined;
      return { text, width: img.width, height: img.height, format: "ocr" };
    } catch (e) {
      process.stderr.write(`[file2md] OCR failed: ${e instanceof Error ? e.message : String(e)}\n`);
      return undefined;
    }
  }

  /** Raster + OCR one PDF page (scanned-page path). Never throws. */
  async recognizePdfPage(pdfBytes: Uint8Array, page: number, scale: number): Promise<OcrResult | undefined> {
    const raster = await rasterPage(pdfBytes, page, scale);
    if (raster === undefined) return undefined;
    return this.recognize(raster.bmp);
  }

  async terminate(): Promise<void> {
    if (this.engine !== undefined) {
      try {
        this.engine.destroy();
      } catch {
        /* best-effort */
      }
      this.engine = undefined;
    }
  }
}

/** One-shot OCR of an image file (degrade-not-fail contract). */
export async function ocrImageFile(imagePath: string, lang = "eng"): Promise<OcrResult | undefined> {
  const session = new OcrSession(normalizeOcrLang(lang));
  try {
    const bytes = new Uint8Array(readFileSync(imagePath));
    return await session.recognize(bytes);
  } catch {
    return undefined;
  } finally {
    await session.terminate().catch(() => undefined);
  }
}

/** Image dimensions parsed from PNG/JPEG/BMP headers (pure, no decode). */
export function imageDims(data: Uint8Array): { width: number; height: number } | undefined {
  if (data.length < 8) return undefined;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // PNG: IHDR at 16 (w,h big-endian)
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    if (data.length < 24) return undefined;
    return { width: dv.getUint32(16, false), height: dv.getUint32(20, false) };
  }
  // BMP: 12: width, 16: height (little-endian, positive for bottom-up)
  if (data[0] === 0x42 && data[1] === 0x4d) {
    if (data.length < 26) return undefined;
    return { width: dv.getInt32(18, true), height: Math.abs(dv.getInt32(22, true)) };
  }
  // JPEG: scan markers for SOF0/SOF2 (trivial parse; dims big-endian)
  if (data[0] === 0xff && data[1] === 0xd8) {
    let o = 2;
    while (o + 9 < data.length) {
      if (data[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = data[o + 1]!;
      // Skip standalone markers.
      if (marker >= 0xd0 && marker <= 0xd7) {
        o += 2;
        continue;
      }
      if (marker === 0xff) {
        o++;
        continue;
      }
      const len = dv.getUint16(o + 2, false);
      if ((marker === 0xc0 || marker === 0xc2) && data.length >= o + 9) {
        return { width: dv.getUint16(o + 7, false), height: dv.getUint16(o + 5, false) };
      }
      o += 2 + len;
    }
    return undefined;
  }
  return undefined;
}
