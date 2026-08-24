/**
 * ocr-engine.test.ts — live engine tests: the real tesseract-wasm core plus
 * npm-shipped lang data (`@tesseract.js-data/*.traineddata.gz`, gunzipped
 * in-process) load off disk and recognition runs. Needs only the package deps
 * (`bun install` from bun-apps/) — no network, no external binary store.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  collapseCjkSpaces,
  containsCjk,
  mergeOcrLines,
  normalizeOcrLang,
  npmLangPath,
  type OcrLine,
  OcrSession,
} from "../src/ocr/ocr.ts";
import { bgraToBmp } from "../src/raster/bmp.ts";
import { rasterPage } from "../src/raster/pdf.ts";
import { prosePdf } from "./helpers/docs.ts";

const sessions: OcrSession[] = [];

function session(lang: string): OcrSession {
  const s = new OcrSession(lang);
  sessions.push(s);
  return s;
}

afterAll(async () => {
  for (const s of sessions) await s.terminate().catch(() => undefined);
});

describe("npmLangPath", () => {
  test("resolves a real .traineddata.gz on disk for eng + chi_sim", () => {
    const expected = { eng: "eng", chi_sim: "chi_sim" } as const;
    for (const part of ["eng", "chi_sim"] as const) {
      const p = npmLangPath(part);
      expect(p).toBeDefined();
      if (p === undefined) continue; // the assertion above documents the contract
      expect(p.endsWith(`${expected[part]}.traineddata.gz`)).toBe(true);
      // Readable on disk — the file the engine will gunzip.
      expect(statSync(p).size).toBeGreaterThan(100_000);
    }
  });

  test("unknown part → undefined", () => {
    expect(npmLangPath("jpn")).toBeUndefined();
  });
});

describe("live engine (tesseract-wasm core + npm lang data)", () => {
  test("init() loads wasm + eng+chi_sim models", async () => {
    expect(normalizeOcrLang("en+zh")).toBe("eng+chi_sim");
    expect(await session("eng+chi_sim").init()).toBe(true);
  });

  test("recognize(blank BMP) → undefined (no text, never throws)", async () => {
    const s = session("eng");
    expect(await s.init()).toBe(true);
    const bmp = bgraToBmp(new Uint8Array(64 * 64 * 4), 64, 64);
    expect(await s.recognize(bmp)).toBeUndefined();
  });

  test("FILE2MD_OCR_LANG_PATH raw-dir override wins", async () => {
    const dir = mkdtempSync(join(tmpdir(), "file2md-ocr-lang-"));
    try {
      const gz = npmLangPath("eng");
      expect(gz).toBeDefined();
      if (gz === undefined) return;
      writeFileSync(join(dir, "eng.traineddata"), gunzipSync(readFileSync(gz)));
      process.env.FILE2MD_OCR_LANG_PATH = dir;
      expect(await session("eng").init()).toBe(true);
    } finally {
      delete process.env.FILE2MD_OCR_LANG_PATH;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("eng+chi_sim on a rasterized prose page returns eng-quality text (multi-pass merge beats first-model-wins)", async () => {
    // Regression pin: tesseract-wasm's OCREngine keeps only the FIRST loaded
    // model, so pre-fix "chi_sim+eng" (and "eng+chi_sim") silently degraded to
    // the first pass — chi_sim's garbled Latin. Post-fix the passes merge per
    // line and eng's confident reading must win on this all-Latin page.
    const pdf = await prosePdf();
    const raster = await rasterPage(pdf, 1, 3);
    expect(raster).toBeDefined();
    if (raster === undefined) return;
    const s = session("chi_sim+eng");
    expect(await s.init()).toBe(true);
    const result = await s.recognize(raster.bmp);
    expect(result).toBeDefined();
    // Exact prose start — chi_sim-only output garbles these words.
    expect(result?.text).toContain("explains the module architecture");
    expect(result?.text).toContain("eye diagrams");
  });
});

describe("multi-lang line merge (pure)", () => {
  const line = (text: string, confidence: number, top: number, bottom: number): OcrLine => ({
    text,
    confidence,
    top,
    bottom,
  });

  test("CJK side wins over eng garbage even at 0.00 confidence (measured title trap: chi 0.00 vs eng 0.21)", () => {
    const eng = [line("REESE] SEMEN Lik", 0.21, 120, 180)];
    const chi = [line("深度学习与图神经网络综述", 0.0, 120, 180)];
    expect(mergeOcrLines(eng, chi)[0]?.text).toBe("深度学习与图神经网络综述");
  });

  test("confident non-CJK reading beats unsure CJK hallucination", () => {
    const eng = [line("Neural networks are machine-learning models", 0.95, 100, 140)];
    const chi = [line("神经", 0.4, 100, 140)];
    expect(mergeOcrLines(eng, chi)[0]?.text).toBe("Neural networks are machine-learning models");
  });

  test("CJK side with >= 0.5 confidence wins over junk eng (meta line: chi 0.91 vs eng 0.49)", () => {
    const eng = [line("#5 2% - Chapter2 - 2026 4E 8 FJ", 0.49, 500, 560)];
    const chi = [line("第 2 章 . Chapter2 . 2026 年 8 月 . 内部技术报告", 0.91, 500, 560)];
    expect(mergeOcrLines(eng, chi)[0]?.text).toBe("第 2 章 . Chapter2 . 2026 年 8 月 . 内部技术报告");
  });

  test("no CJK on either side → higher confidence wins (eng paragraph)", () => {
    const eng = [line("Neural networks are machine-learning models", 0.92, 100, 140)];
    const chi = [line("Neutal netwotks atre machine-leathing models", 0.75, 100, 140)];
    expect(mergeOcrLines(eng, chi)[0]?.text).toBe("Neural networks are machine-learning models");
  });

  test("both sides CJK → higher confidence wins", () => {
    const a = [line("神经网络", 0.5, 100, 140)];
    const b = [line("神经网络", 0.9, 100, 140)];
    expect(mergeOcrLines(a, b)[0]?.text).toBe("神经网络");
  });

  test("lines seen in only one pass are kept and the result is sorted by top", () => {
    const a = [line("only-in-a-near-top", 0.9, 100, 140), line("shared lower", 0.9, 400, 440)];
    const b = [line("shared lower", 0.8, 400, 440), line("only-in-b-tail", 0.7, 900, 940)];
    const merged = mergeOcrLines(a, b);
    expect(merged.map((l) => l.text)).toEqual(["only-in-a-near-top", "shared lower", "only-in-b-tail"]);
  });

  test("empty passes are ignored in the merge", () => {
    const a = [line(" ", 0.95, 100, 140), line("text", 0.9, 200, 240)];
    const b: OcrLine[] = [];
    expect(mergeOcrLines(a, b).map((l) => l.text)).toEqual(["text"]);
  });

  test("collapseCjkSpaces removes inter-Han spaces only", () => {
    expect(collapseCjkSpaces("深 度 学 习 与 图 神经")).toBe("深度学习与图神经");
    // "第 2 章" — space touching a digit stays (not Han-Han).
    expect(collapseCjkSpaces("第 2 章 . Chapter2")).toBe("第 2 章 . Chapter2");
  });

  test("containsCjk detects Han and rejects Latin", () => {
    expect(containsCjk("深度学习")).toBe(true);
    expect(containsCjk("Deep Learning")).toBe(false);
    expect(containsCjk("中文 x")).toBe(true);
  });
});
