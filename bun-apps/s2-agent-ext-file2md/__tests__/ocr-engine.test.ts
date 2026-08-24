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
import { OcrSession, npmLangPath, normalizeOcrLang } from "../src/ocr/ocr.ts";
import { bgraToBmp } from "../src/raster/bmp.ts";

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
});
