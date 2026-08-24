/// <reference path="./tesseract-wasm.d.ts" />
/**
 * ocr/ocr.ts — local OCR via tesseract-wasm (robertknight, bun-only, offline).
 *
 * Replaces v1's macOS-Vision Swift CLI and v2's tesseract.js worker: the
 * in-process low-level `OCREngine` (no worker_threads, no runtime network —
 * the wasm core + lang data come off disk). The wasm core is the npm
 * tesseract-wasm package's `dist/tesseract-core.wasm`; lang data (eng/chi_sim)
 * ships as gzipped `.traineddata` inside the `@tesseract.js-data` npm packages
 * (tessdata 4.0.0 best-int), gunzipped in-process and cached per part.
 * `FILE2MD_OCR_LANG_PATH` overrides with a raw `.traineddata` dir. Every
 * failure degrades to `undefined` with an explicit stderr note (never throws),
 * mirroring v1's degrade-not-fail contract. hermes-memory consumes `OcrResult`.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
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

/** In-npm data subdir: tessdata 4.0.0 best-int (tesseract.js's integerized production set). */
const LANG_GZ_DIR = "4.0.0_best_int";

/** lang `.traineddata.gz` path inside one of the `@tesseract.js-data` npm packages. */
const LANG_NPM_PACKAGES: Record<string, string> = { eng: "eng", chi_sim: "chi_sim" };

/**
 * Map a lang part to its npm-shipped `.traineddata.gz` path. Resolved by
 * specifier (template, non-literal — a literal would be inlined to the
 * build-machine path by the bundler): dev — workspace node_modules; deploy —
 * the vendored copy at `<extDir>/node_modules/@tesseract.js-data/<part>/`.
 */
export function npmLangPath(part: string): string | undefined {
  const pkg = LANG_NPM_PACKAGES[part];
  if (pkg === undefined) return undefined;
  try {
    const pkgRoot = dirname(require.resolve(`@tesseract.js-data/${pkg}/package.json`));
    return join(pkgRoot, LANG_GZ_DIR, `${part}.traineddata.gz`);
  } catch {
    return undefined;
  }
}

/**
 * The wasm core's path in the vendored tesseract-wasm package. Resolved by
 * specifier — dev: workspace node_modules; deploy: the vendored copy at
 * `<extDir>/node_modules/tesseract-wasm/` — NOT the package's `node` subpath,
 * which is the worker_threads adapter we deliberately do not use.
 */
function wasmBinaryPath(): string | undefined {
  try {
    const pkg = dirname(require.resolve("tesseract-wasm/package.json"));
    return join(pkg, "dist", "tesseract-core.wasm");
  } catch {
    return undefined;
  }
}

/** Read the wasm core off disk (cached per process). Degrades cleanly on failure. */
async function loadWasmBinary(): Promise<Uint8Array | undefined> {
  const path = wasmBinaryPath();
  if (path === undefined) return undefined;
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return undefined;
  }
}

/** wasm binary cache (1.8 MB fs read — load once per process). */
let wasmBinaryCache: Uint8Array | undefined;

/** gunzipped lang `.traineddata` cache per part (load once per process). */
const langDataCache = new Map<string, Uint8Array>();

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
  private langPath: string | undefined;
  constructor(lang: string, langPath?: string) {
    // Engine models are raw `lang.traineddata` files — normalize aliases
    // here so a caller passing "en" gets the "eng" model, not ENOENT.
    this.lang = normalizeOcrLang(lang);
    this.langPath = langPath;
  }

  /**
   * Model bytes for one lang part. Order: explicit langPath (raw dir) →
   * `FILE2MD_OCR_LANG_PATH` (raw dir) → the npm `.traineddata.gz` (gunzipped,
   * cached per part). Throws when nothing is resolvable; init catches.
   */
  private loadModelBytes(part: string): Uint8Array {
    const rawDir = this.langPath ?? (process.env.FILE2MD_OCR_LANG_PATH?.trim() || undefined);
    if (rawDir !== undefined) return readFileSync(join(rawDir, `${part}.traineddata`));
    const cached = langDataCache.get(part);
    if (cached !== undefined) return cached;
    const gzPath = npmLangPath(part);
    if (gzPath === undefined) {
      throw new Error(`lang data "${part}" not found (@tesseract.js-data/${part} not installed)`);
    }
    const bytes = gunzipSync(readFileSync(gzPath));
    langDataCache.set(part, bytes);
    return bytes;
  }

  async init(): Promise<boolean> {
    if (this.engine !== undefined) return true;
    try {
      if (wasmBinaryCache === undefined) {
        wasmBinaryCache = await loadWasmBinary();
        if (wasmBinaryCache === undefined) throw new Error("tesseract-wasm core not found (vendored package missing)");
      }
      const engine = await createOCREngine({ wasmBinary: wasmBinaryCache });
      // Load one `.traineddata` per lang part ("eng+chi_sim" → 2 loads).
      let loaded = false;
      for (const part of this.lang.split("+")) {
        engine.loadModel(this.loadModelBytes(part));
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
