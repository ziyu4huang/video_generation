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
import { createOCREngine, type OCREngine, type OcrEngineImage } from "tesseract-wasm";
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

/** Han-script detector for the multi-lang line merge. */
const HAN_RE = /\p{Script=Han}/u;

/** True when the text contains Han characters (chi_sim output signal). */
export function containsCjk(text: string): boolean {
  return HAN_RE.test(text);
}

/** "深 度 学 习" → "深度学习" (spaces between Han chars are chi_sim spacing artifacts). */
export function collapseCjkSpaces(text: string): string {
  return text.replace(/(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu, "");
}

/** Match hinge: |centerA − centerB| ≤ LINE_MATCH_RATIO × max(height, LINE_MIN_HEIGHT). */
const LINE_MATCH_RATIO = 0.35;
const LINE_MIN_HEIGHT = 20;
/** Horizontal overlap requirement: ≥ 30% of the narrower line's width. */
const LINE_X_POLICY = 0.3;
/** The CJK side of a pair wins unless the other side read it at ≥ CJK_CONF_IDENTITY. */
const CJK_CONF_IDENTITY = 0.5;

/**
 * One OCR line for the multi-lang merge: text + confidence + box. The box
 * (top/bottom/left/right) is used to match the same visual line across
 * language passes; horizontal extent is REQUIRED for a match so that two
 * visually distinct lines at the same y (e.g. text + inline figure labels)
 * are not paired.
 */
export interface OcrLine {
  text: string;
  confidence: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const lineCenter = (l: OcrLine) => (l.top + l.bottom) / 2;

/** horizontal overlap of two lines, as a fraction of the narrower width (0 = none). */
function xOverlap(a: OcrLine, b: OcrLine): number {
  const w = Math.min(a.right - a.left, b.right - b.left);
  if (w <= 0) return 0;
  const ov = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  return Math.max(0, ov) / w;
}

/**
 * Merge two single-model passes ("eng" lines vs "chi_sim" lines of the same
 * page) into one line list. tesseract-wasm's OCREngine keeps only the FIRST
 * model loaded — so one engine per lang part, one pass per part, then merge.
 *
 * Matching: greedy nearest-center within a vertical tolerance plus a
 * horizontal-overlap requirement. Decision per matched pair: a CJK side wins
 * unless the other side read the line confidently (>= CJK_CONF_IDENTITY) and
 * the CJK side was unsure (< CJK_CONF_IDENTITY) — eng never emits real Han
 * for Chinese text, so a CJK line in either pass is almost always the
 * chi_sim reading; the confidence guard is for tiny hallucinated CJK chars
 * inside a confidently-read Latin line. Lines seen in only one pass are
 * kept as-is; a leftover line that duplicates an already-kept line of the
 * same visual row (one pass split the row into two boxes) is dropped, the
 * higher-confidence one wins. Result sorted by top.
 */
export function mergeOcrLines(a: OcrLine[], b: OcrLine[]): OcrLine[] {
  const used = new Set<number>();
  const result: OcrLine[] = [];
  for (const la of a) {
    if (la.text.trim() === "") continue;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < b.length; i++) {
      if (used.has(i)) continue;
      const lb = b[i];
      if (lb === undefined || lb.text.trim() === "") continue;
      if (xOverlap(la, lb) < LINE_X_POLICY) continue;
      const d = Math.abs(lineCenter(la) - lineCenter(lb));
      if (d <= LINE_MATCH_RATIO * Math.max(la.bottom - la.top, lb.bottom - lb.top, LINE_MIN_HEIGHT) && d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      const lb = b[bestIdx];
      if (lb !== undefined) {
        used.add(bestIdx);
        result.push(pickOcrLine(la, lb));
      }
    } else {
      result.push(la);
    }
  }
  for (let i = 0; i < b.length; i++) {
    const lb = b[i];
    if (!used.has(i) && lb !== undefined && lb.text.trim() !== "") result.push(lb);
  }
  // Split-row dedupe: a row one pass segmented into 2 boxes keeps both
  // leftovers — drop the duplicate, preferring the higher confidence.
  const deduped: OcrLine[] = [];
  for (const l of result.sort((x, y) => x.top - y.top)) {
    const dup = deduped.find(
      (k) =>
        xOverlap(l, k) >= 0.5 &&
        Math.abs(lineCenter(l) - lineCenter(k)) <= LINE_MATCH_RATIO * Math.max(k.bottom - k.top, LINE_MIN_HEIGHT),
    );
    if (dup === undefined) {
      deduped.push(l);
    } else if (l.confidence > dup.confidence) {
      const i = deduped.indexOf(dup);
      deduped[i] = l;
    }
  }
  return deduped;
}

function pickOcrLine(a: OcrLine, b: OcrLine): OcrLine {
  const aCjk = containsCjk(a.text);
  const bCjk = containsCjk(b.text);
  if (aCjk !== bCjk) {
    const cjk = aCjk ? a : b;
    const other = aCjk ? b : a;
    if (cjk.confidence >= CJK_CONF_IDENTITY || other.confidence < CJK_CONF_IDENTITY) return cjk;
    return other;
  }
  return a.confidence >= b.confidence ? a : b;
}

/**
 * Reusable per-document OCR session: one engine per lang part, many pages,
 * then terminate. Single-part langs keep the original one-engine path;
 * multi-part langs ("eng+chi_sim") run one pass per part and merge lines
 * (see `mergeOcrLines` — the engine cannot combine models in one pass).
 * Capable of PNG/JPEG/BMP buffers — raw pages cross as BMP via the raster
 * layer, everything else via the image decoders (`decodeImageToRgba`).
 */
export class OcrSession {
  private engine: OCREngine | undefined;
  private partEngines = new Map<string, OCREngine>();
  private initFailed = false;
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

  private async partEngine(part: string): Promise<OCREngine | undefined> {
    const cached = this.partEngines.get(part);
    if (cached !== undefined) return cached;
    // wasmBinaryCache is guaranteed non-undefined after a successful init().
    if (wasmBinaryCache === undefined) return undefined;
    let engine: OCREngine | undefined;
    try {
      engine = await createOCREngine({ wasmBinary: wasmBinaryCache });
      engine.loadModel(this.loadModelBytes(part));
      this.partEngines.set(part, engine);
      return engine;
    } catch (e) {
      // Never leak a partial engine when model loading throws.
      try {
        engine?.destroy();
      } catch {
        /* best-effort */
      }
      process.stderr.write(
        `[file2md] tesseract-wasm model "${part}" load failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return undefined;
    }
  }

  async init(): Promise<boolean> {
    if (this.initFailed) return false;
    if (this.engine !== undefined || this.partEngines.size > 0) return true;
    try {
      if (wasmBinaryCache === undefined) {
        wasmBinaryCache = await loadWasmBinary();
        if (wasmBinaryCache === undefined) throw new Error("tesseract-wasm core not found (vendored package missing)");
      }
      const parts = this.lang.split("+");
      if (parts.length === 1) {
        const part = parts[0];
        if (part === undefined) throw new Error(`no model for "${this.lang}"`);
        const engine = await createOCREngine({ wasmBinary: wasmBinaryCache });
        engine.loadModel(this.loadModelBytes(part));
        this.engine = engine;
      } else {
        for (const part of parts) {
          if ((await this.partEngine(part)) === undefined) throw new Error(`model "${part}" failed to load`);
        }
      }
      return true;
    } catch (e) {
      process.stderr.write(`[file2md] tesseract-wasm init failed: ${e instanceof Error ? e.message : String(e)}\n`);
      this.engine = undefined;
      for (const [part, e] of this.partEngines) {
        try {
          e.destroy();
        } catch {
          /* best-effort */
        }
        this.partEngines.delete(part);
      }
      // Latched: a failing model (e.g. raw-dir override with a partial set)
      // must not churn a fresh wasm instance per page — degrade once.
      this.initFailed = true;
      return false;
    }
  }

  /** OCR one encoded image (PNG/JPEG/BMP) → RGBA → sync engine(s). */
  async recognize(data: Uint8Array): Promise<OcrResult | undefined> {
    if (this.initFailed) return undefined;
    if (this.engine === undefined && this.partEngines.size === 0 && !(await this.init())) return undefined;
    try {
      const img = decodeImageToRgba(data);
      if (img === undefined) return undefined;
      if (this.engine !== undefined) {
        const text = this.recognizeWithEngine(this.engine, img);
        if (text === "") return undefined;
        return { text, width: img.width, height: img.height, format: "ocr" };
      }
      const parts = this.lang.split("+");
      let lines: OcrLine[] = [];
      let haveLines = false;
      for (const part of parts) {
        const engine = this.partEngines.get(part) ?? (await this.partEngine(part));
        if (engine === undefined) return undefined;
        lines = haveLines ? mergeOcrLines(lines, this.linePass(engine, img)) : this.linePass(engine, img);
        haveLines = true;
      }
      const text = lines
        .map((l) => collapseCjkSpaces(l.text))
        .join("\n")
        .trim();
      if (text === "") return undefined;
      return { text, width: img.width, height: img.height, format: "ocr" };
    } catch (e) {
      process.stderr.write(`[file2md] OCR failed: ${e instanceof Error ? e.message : String(e)}\n`);
      return undefined;
    }
  }

  /** Single-model pass: recognize the current image, return its line boxes. */
  private linePass(engine: OCREngine, img: OcrEngineImage): OcrLine[] {
    engine.loadImage(img);
    return engine
      .getTextBoxes("line")
      .map((b) => ({
        text: b.text.trim(),
        confidence: b.confidence,
        top: b.rect.top,
        bottom: b.rect.bottom,
        left: b.rect.left,
        right: b.rect.right,
      }))
      .filter((l) => l.text !== "");
  }

  /** Single-part path — raw text, unchanged behavior. */
  private recognizeWithEngine(engine: OCREngine, img: OcrEngineImage): string {
    engine.loadImage(img);
    return (engine.getText() ?? "").trim();
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
    for (const [part, engine] of this.partEngines) {
      try {
        engine.destroy();
      } catch {
        /* best-effort */
      }
      this.partEngines.delete(part);
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
