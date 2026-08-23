/**
 * smart-mode.test.ts — `--extract smart` end-to-end (ticket 01).
 *
 * Same discipline as pipeline-v2.test.ts: the REAL pipeline runs against
 * pdf-lib fixtures; only the wasm/worker pair (raster/pdf.ts + ocr/ocr.ts)
 * is stubbed. The vision leaf (../src/sessions.ts) is mocked to be
 * configurable so the no-server degrade is deterministic regardless of the
 * host's ~/.pi vision config.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIGURE_SKIP_NOTICE } from "../src/core/figure.ts";

const calls = { raster: 0, ocr: 0 };
const ocrState = { text: "OCR TEXT 42" };
const visionState = { available: false };

mock.module("../src/raster/pdf.ts", () => ({
  rasterPage: async () => {
    calls.raster++;
    return { bmp: new Uint8Array(8 * 8 * 4), width: 8, height: 8 };
  },
}));

mock.module("../src/ocr/ocr.ts", () => ({
  OcrSession: class {
    constructor(public lang = "eng") {}
    async recognize(): Promise<{ text: string; width: number; height: number; format: string }> {
      calls.ocr++;
      return { text: ocrState.text, width: 8, height: 8, format: "ocr" };
    }
    async terminate(): Promise<void> {}
  },
  ocrImageFile: async () => {
    calls.ocr++;
    return { text: "IMG OCR", width: 8, height: 8, format: "ocr" };
  },
  normalizeOcrLang: (l?: string) => {
    const m = (l ?? "en").toLowerCase();
    return m === "chi_sim" || m === "zh" ? "chi_sim" : "eng";
  },
  imageDims: () => ({ width: 8, height: 8 }),
}));

mock.module("../src/sessions.ts", () => ({
  resolveVisionLLM: () => {
    if (!visionState.available) throw new Error("no vision capability configured");
    return { provider: "lm-studio", modelId: "mock-vlm", thinkingLevel: "off" as const };
  },
}));

const { parseMode, runFile2mdPipeline } = await import("../src/pipeline.ts");
const { captionFigurePdf, prosePdf, scannedPdf, textPdf } = await import("./helpers/docs.ts");

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "file2md-smart-test-"));
  calls.raster = 0;
  calls.ocr = 0;
  ocrState.text = "OCR TEXT 42";
  visionState.available = false;
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function writeFixture(name: string, bytes: Uint8Array): Promise<string> {
  const p = join(tmp, name);
  await writeFile(p, bytes);
  return p;
}

describe("parseMode", () => {
  test("smart parses; auto still converges on ocr; invalid lists all modes", () => {
    expect(parseMode("smart")).toBe("smart");
    expect(parseMode("auto")).toBe("ocr");
    expect(() => parseMode("bogus")).toThrow(/Valid: auto, text, ocr, vlm, smart/);
  });
});

describe("smart — text-page ladder", () => {
  test("caption-only-figure page flags + skip notice + manifest record + doc_done (no server)", async () => {
    const pdf = await writeFixture("fig.pdf", await captionFigurePdf());
    const emitted: unknown[] = [];
    await runFile2mdPipeline({ inputs: [pdf], outRoot: tmp, mode: "smart", emit: (o) => emitted.push(o) });
    // Ladder order: a text figure page must never rasterize in ticket 01
    // (no enhancement to run) and a usable text page never OCRs.
    expect(calls.raster).toBe(0);
    expect(calls.ocr).toBe(0);
    const md = readFileSync(join(tmp, "fig", "pages", "page-001.md"), "utf8");
    expect(md).toContain("Figure 3-4. Adaptive equalization functional diagram.");
    expect(md).toContain(FIGURE_SKIP_NOTICE);
    const manifest = JSON.parse(readFileSync(join(tmp, "fig", "manifest.json"), "utf8"));
    expect(manifest.pages[0].figure).toEqual({ detected: true, enhanced: false });
    expect(emitted.some((e) => (e as { type?: string }).type === "doc_done")).toBe(true);
  });

  test("prose page with an inline Figure mention is NOT flagged and never rasterizes", async () => {
    const pdf = await writeFixture("prose.pdf", await prosePdf());
    await runFile2mdPipeline({ inputs: [pdf], outRoot: tmp, mode: "smart" });
    expect(calls.raster).toBe(0);
    expect(calls.ocr).toBe(0);
    const md = readFileSync(join(tmp, "prose", "pages", "page-001.md"), "utf8");
    expect(md).toContain("shown in Figure 3-4.");
    expect(md).not.toContain(FIGURE_SKIP_NOTICE);
    expect(md).toContain("provenance: text");
    const manifest = JSON.parse(readFileSync(join(tmp, "prose", "manifest.json"), "utf8"));
    expect(manifest.pages[0].figure).toBeUndefined();
  });

  test("usable text page without a caption stays untouched in smart mode", async () => {
    const pdf = await writeFixture("paper.pdf", await textPdf());
    await runFile2mdPipeline({ inputs: [pdf], outRoot: tmp, mode: "smart" });
    expect(calls.raster).toBe(0);
    const md = readFileSync(join(tmp, "paper", "pages", "page-001.md"), "utf8");
    expect(md).toContain("Hello from file2md v2");
    expect(md).not.toContain(FIGURE_SKIP_NOTICE);
    expect(md).toContain("provenance: text");
  });
});

describe("smart — scan-page ladder", () => {
  test("thin page OCRs exactly as ocr mode when OCR output exceeds the band", async () => {
    ocrState.text = "SIMPLE OCR LINE ".repeat(20); // 340 chars > 200
    const pdf = await writeFixture("scan.pdf", await scannedPdf());
    await runFile2mdPipeline({ inputs: [pdf], outRoot: tmp, mode: "smart" });
    expect(calls.raster).toBe(1);
    expect(calls.ocr).toBe(1);
    const md = readFileSync(join(tmp, "scan", "pages", "page-001.md"), "utf8");
    expect(md).toContain(ocrState.text);
    expect(md).toContain("provenance: ocr");
    expect(md).not.toContain(FIGURE_SKIP_NOTICE);
    // OCR pages keep no page PNG (only the vision path stores one).
    expect(existsSync(join(tmp, "scan", "pages", "page-001.png"))).toBe(false);
  });

  test("short labels-only OCR flags the scan page as a figure", async () => {
    ocrState.text = "OCR TEXT 42"; // 12 chars ≤ 200
    const pdf = await writeFixture("scan.pdf", await scannedPdf());
    await runFile2mdPipeline({ inputs: [pdf], outRoot: tmp, mode: "smart" });
    expect(calls.raster).toBe(1);
    expect(calls.ocr).toBe(1);
    const md = readFileSync(join(tmp, "scan", "pages", "page-001.md"), "utf8");
    expect(md).toContain("OCR TEXT 42");
    expect(md).toContain(FIGURE_SKIP_NOTICE);
    expect(md).toContain("provenance: ocr");
    const manifest = JSON.parse(readFileSync(join(tmp, "scan", "manifest.json"), "utf8"));
    expect(manifest.pages[0].figure).toEqual({ detected: true, enhanced: false });
  });
});
