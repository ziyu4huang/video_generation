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

// Ticket 02: the vision-inference seam is mocked with a call counter + task
// capture so the E2E can (a) prove the figureHint variant reached the call,
// (b) count LLM invocations across pages, (c) script the success / #1913-empty /
// rejection outcomes deterministically.
const visionCalls = { calls: 0, lastTask: "", lastImages: [] as unknown[], lastSystemPrompt: "" };
const visionReply = { ok: true as boolean, output: "A diagram of the adaptive equalization chain.", error: "" };

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

mock.module("../src/vlm/vision-inference.ts", () => ({
  runVisionInference: async (opts: { task: string; images: unknown[]; systemPrompt?: string }) => {
    visionCalls.calls++;
    visionCalls.lastTask = opts.task;
    visionCalls.lastImages = opts.images;
    visionCalls.lastSystemPrompt = opts.systemPrompt ?? "";
    if (visionReply.ok) return { output: visionReply.output, ok: true };
    return { output: "", ok: false, error: visionReply.error };
  },
}));

const { parseMode, runFile2mdPipeline } = await import("../src/pipeline.ts");
const { captionFigurePdf, mixedProseFigurePdf, prosePdf, scannedPdf, textPdf } = await import("./helpers/docs.ts");
const { FIGURE_HINT } = await import("../src/vlm/agents.ts");

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "file2md-smart-test-"));
  calls.raster = 0;
  calls.ocr = 0;
  ocrState.text = "OCR TEXT 42";
  visionState.available = false;
  visionCalls.calls = 0;
  visionCalls.lastTask = "";
  visionCalls.lastImages = [];
  visionCalls.lastSystemPrompt = "";
  visionReply.ok = true;
  visionReply.output = "A diagram of the adaptive equalization chain.";
  visionReply.error = "";
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
    expect(visionCalls.calls).toBe(0);
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

describe("smart — vision enhancement on figure pages (ticket 02)", () => {
  test("text figure page + vision: figureHint variant, description appended, manifest enhanced", async () => {
    visionState.available = true;
    const pdf = await writeFixture("fig.pdf", await captionFigurePdf());
    await runFile2mdPipeline({ inputs: [pdf], outRoot: tmp, mode: "smart" });
    // Enhancement runs: exactly one raster, one vision call carrying the hint.
    expect(visionCalls.calls).toBe(1);
    expect(visionCalls.lastTask).toContain(FIGURE_HINT);
    expect(visionCalls.lastImages).toHaveLength(1);
    expect(calls.raster).toBe(1);
    expect(calls.ocr).toBe(0);
    const md = readFileSync(join(tmp, "fig", "pages", "page-001.md"), "utf8");
    // Untouched original body FIRST, then the appended vision section (D3).
    expect(md.indexOf("Figure 3-4. Adaptive equalization functional diagram.")).toBeLessThan(
      md.indexOf("## Figure (vision)"),
    );
    expect(md).toContain("## Figure (vision)");
    expect(md).toContain("A diagram of the adaptive equalization chain.");
    expect(md).toContain("enhanced: vision");
    expect(md).not.toContain(FIGURE_SKIP_NOTICE);
    // The one rasterization is stored as the page image.
    expect(existsSync(join(tmp, "fig", "pages", "page-001.png"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(tmp, "fig", "manifest.json"), "utf8"));
    expect(manifest.pages[0].figure).toEqual({ detected: true, enhanced: true });
  });

  test("scan figure page + short OCR: vision called, description appended to the OCR body", async () => {
    visionState.available = true;
    ocrState.text = "FIG 5-1. EYE DIAGRAM"; // 21 chars ≤ 200 band
    const pdf = await writeFixture("scan.pdf", await scannedPdf());
    await runFile2mdPipeline({ inputs: [pdf], outRoot: tmp, mode: "smart" });
    expect(calls.raster).toBe(1); // OCR's raster is reused for enhancement — once
    expect(calls.ocr).toBe(1);
    expect(visionCalls.calls).toBe(1);
    expect(visionCalls.lastTask).toContain(FIGURE_HINT);
    const md = readFileSync(join(tmp, "scan", "pages", "page-001.md"), "utf8");
    expect(md.indexOf("FIG 5-1. EYE DIAGRAM")).toBeLessThan(md.indexOf("## Figure (vision)"));
    expect(md).toContain("## Figure (vision)");
    expect(md).toContain("A diagram of the adaptive equalization chain.");
    expect(md).toContain("provenance: ocr");
    expect(md).toContain("enhanced: vision");
    expect(md).not.toContain(FIGURE_SKIP_NOTICE);
    const manifest = JSON.parse(readFileSync(join(tmp, "scan", "manifest.json"), "utf8"));
    expect(manifest.pages[0].figure).toEqual({ detected: true, enhanced: true });
  });

  test("scan page + long OCR: band fails, vision never called", async () => {
    visionState.available = true;
    ocrState.text = "SIMPLE OCR LINE ".repeat(20); // 340 chars > 200
    const pdf = await writeFixture("scan.pdf", await scannedPdf());
    await runFile2mdPipeline({ inputs: [pdf], outRoot: tmp, mode: "smart" });
    expect(visionCalls.calls).toBe(0);
    const md = readFileSync(join(tmp, "scan", "pages", "page-001.md"), "utf8");
    expect(md).toContain(ocrState.text);
    expect(md).not.toContain("## Figure (vision)");
    expect(md).not.toContain(FIGURE_SKIP_NOTICE);
  });

  test("empty/rejected vision output degrades: skip notice, enhanced false, page still done", async () => {
    visionState.available = true;
    visionReply.ok = false;
    visionReply.error = "vision model completed with no output text (possible reasoning/token-budget truncation)";
    const pdf = await writeFixture("fig.pdf", await captionFigurePdf());
    await runFile2mdPipeline({ inputs: [pdf], outRoot: tmp, mode: "smart" });
    // ok:false is a RETURN, not a throw → withRetry no-ops → exactly one call.
    expect(visionCalls.calls).toBe(1);
    expect(calls.raster).toBe(1); // the attempt still rasterized exactly once
    const md = readFileSync(join(tmp, "fig", "pages", "page-001.md"), "utf8");
    expect(md).toContain("Figure 3-4. Adaptive equalization functional diagram.");
    expect(md).toContain(FIGURE_SKIP_NOTICE);
    expect(md).not.toContain("## Figure (vision)");
    expect(md).not.toContain("enhanced: vision");
    // Degrade stores no page png — enhanced:false record only.
    expect(existsSync(join(tmp, "fig", "pages", "page-001.png"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(tmp, "fig", "manifest.json"), "utf8"));
    expect(manifest.pages[0].figure).toEqual({ detected: true, enhanced: false });
    expect(manifest.pages[0].status).toBe("done");
  });

  test("prose and plain text pages never invoke the vision LLM", async () => {
    visionState.available = true;
    const prose = await writeFixture("prose.pdf", await prosePdf());
    const paper = await writeFixture("paper.pdf", await textPdf());
    await runFile2mdPipeline({ inputs: [prose, paper], outRoot: tmp, mode: "smart" });
    expect(visionCalls.calls).toBe(0);
    expect(calls.raster).toBe(0);
    expect(calls.ocr).toBe(0);
  });

  test("soft resolve: leaf throwing → llm-undefined, run continues VLM-free (D4)", async () => {
    // visionState.available = false (beforeEach default): the mock leaf throws
    // → smart catches → llm stays undefined; pages flag + notice, never fail.
    const pdf = await writeFixture("fig.pdf", await captionFigurePdf());
    await runFile2mdPipeline({ inputs: [pdf], outRoot: tmp, mode: "smart" });
    expect(visionCalls.calls).toBe(0);
    const md = readFileSync(join(tmp, "fig", "pages", "page-001.md"), "utf8");
    expect(md).toContain(FIGURE_SKIP_NOTICE);
    const manifest = JSON.parse(readFileSync(join(tmp, "fig", "manifest.json"), "utf8"));
    expect(manifest.pages[0].figure).toEqual({ detected: true, enhanced: false });
    expect(manifest.pages[0].status).toBe("done");
  });
});

describe("smart — resume + --pages interaction (ticket 03)", () => {
  test("resume: an enhanced page is never re-rasterized or re-described", async () => {
    visionState.available = true;
    const pdf = await writeFixture("fig.pdf", await captionFigurePdf());
    await runFile2mdPipeline({ inputs: [pdf], outRoot: tmp, mode: "smart" });
    expect(visionCalls.calls).toBe(1);
    expect(calls.raster).toBe(1);
    const before = readFileSync(join(tmp, "fig", "pages", "page-001.md"), "utf8");

    // Second run over the same output: the done page is skipped wholesale —
    // no re-raster, no re-OCR, no second vision call (call-counter assertions).
    await runFile2mdPipeline({ inputs: [pdf], outRoot: tmp, mode: "smart" });
    expect(calls.raster).toBe(1);
    expect(calls.ocr).toBe(0);
    expect(visionCalls.calls).toBe(1);
    const after = readFileSync(join(tmp, "fig", "pages", "page-001.md"), "utf8");
    expect(after).toBe(before); // untouched byte-for-byte
    expect(after.match(/## Figure \(vision\)/)).toHaveLength(1);
    const manifest = JSON.parse(readFileSync(join(tmp, "fig", "manifest.json"), "utf8"));
    expect(manifest.pages[0].figure).toEqual({ detected: true, enhanced: true });
    expect(manifest.pages[0].status).toBe("done");
  });

  test("resume: a flag-only page (no server) is not retroactively enhanced when a server appears later", async () => {
    const pdf = await writeFixture("fig.pdf", await captionFigurePdf());
    // Pass 1: no vision server → flagged, not enhanced.
    await runFile2mdPipeline({ inputs: [pdf], outRoot: tmp, mode: "smart" });
    expect(visionCalls.calls).toBe(0);
    let manifest = JSON.parse(readFileSync(join(tmp, "fig", "manifest.json"), "utf8"));
    expect(manifest.pages[0].figure).toEqual({ detected: true, enhanced: false });
    // Pass 2: server now available — but the page is DONE; resume must not redo it.
    visionState.available = true;
    await runFile2mdPipeline({ inputs: [pdf], outRoot: tmp, mode: "smart" });
    expect(visionCalls.calls).toBe(0);
    expect(calls.raster).toBe(0);
    manifest = JSON.parse(readFileSync(join(tmp, "fig", "manifest.json"), "utf8"));
    expect(manifest.pages[0].figure).toEqual({ detected: true, enhanced: false });
    expect(manifest.pages[0].status).toBe("done");
    const md = readFileSync(join(tmp, "fig", "pages", "page-001.md"), "utf8");
    expect(md).not.toContain("## Figure (vision)");
  });

  test("--pages selects only the figure page (page 1 untouched, pending)", async () => {
    visionState.available = true;
    const pdf = await writeFixture("mixed.pdf", await mixedProseFigurePdf());
    await runFile2mdPipeline({ inputs: [pdf], outRoot: tmp, mode: "smart", pages: "2" });
    // Only page 2 (figure) ran enhancement — one vision call, page 1 untouched.
    expect(visionCalls.calls).toBe(1);
    expect(calls.raster).toBe(1);
    expect(calls.ocr).toBe(0);
    expect(existsSync(join(tmp, "mixed", "pages", "page-001.md"))).toBe(false);
    const fig = readFileSync(join(tmp, "mixed", "pages", "page-002.md"), "utf8");
    expect(fig).toContain("## Figure (vision)");
    expect(existsSync(join(tmp, "mixed", "pages", "page-002.png"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(tmp, "mixed", "manifest.json"), "utf8"));
    expect(manifest.pages[0].status).toBe("pending");
    expect(manifest.pages[0].figure).toBeUndefined();
    expect(manifest.pages[1].status).toBe("done");
    expect(manifest.pages[1].figure).toEqual({ detected: true, enhanced: true });
  });

  test("--pages excludes the figure page (no vision calls, figure page pending)", async () => {
    visionState.available = true;
    const pdf = await writeFixture("mixed.pdf", await mixedProseFigurePdf());
    await runFile2mdPipeline({ inputs: [pdf], outRoot: tmp, mode: "smart", pages: "1" });
    expect(visionCalls.calls).toBe(0);
    expect(calls.raster).toBe(0);
    expect(calls.ocr).toBe(0);
    const prose = readFileSync(join(tmp, "mixed", "pages", "page-001.md"), "utf8");
    expect(prose).toContain("provenance: text");
    expect(prose).toContain("shown in Figure 3-4.");
    expect(existsSync(join(tmp, "mixed", "pages", "page-002.md"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(tmp, "mixed", "manifest.json"), "utf8"));
    expect(manifest.pages[0].status).toBe("done");
    expect(manifest.pages[0].figure).toBeUndefined();
    expect(manifest.pages[1].status).toBe("pending");
  });
});
