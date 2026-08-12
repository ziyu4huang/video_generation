/**
 * pipeline-extract.test.ts — runVlmDescribePipeline with `extract: "text"`.
 *
 * Task 5: the text branch extracts a born-digital PDF's text layer via
 * `extractPdfText` (mupdf) and writes per-page markdown WITHOUT rasterizing
 * or calling the VLM. This suite proves that contract deterministically.
 *
 * Mock surface (realm-scoped under `bun test --isolate`):
 *   - `native/pdftext.ts`  → `extractPdfText` returns canned page text
 *                           (also keeps the real mupdf WASM out of the realm —
 *                            its TDZ fires only at the call site under isolate)
 *   - `vlm/ask.ts`         → `askImage` sentinel (must NEVER fire for `text`)
 *   - `vlm/vision-inference.ts` → `runVisionInference` sentinel (the actual
 *                           VLM boundary pipeline.ts uses; must NEVER fire)
 *   - `sessions.ts`        → `resolveVisionLLM`/`resolveLLM` THROW when invoked
 *                           (mirror the real no-model contract, ticket 01);
 *                           text mode must NEVER reach them (Important fix)
 *
 * The fake input is a minimal `%PDF-1.5` magic-bytes file: `classifyKind`
 * sniffs the first bytes → kind "pdf", but since the text branch skips
 * `prepareDoc`, `rasterizePdf` is never asked to actually render it.
 *
 *   bun test --isolate __tests__/pipeline-extract.test.ts
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = import.meta.dirname + "/..";

// --- canned data ------------------------------------------------------------
// Shared by the text + hybrid suites.
const CANNED_TEXT = "HELLO BODY";
const FIGURE_REPLY = "FIGURE: a circuit diagram with three resistors (R1, R2, R3).";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// --- parameterized mock state (reset in beforeEach) -------------------------
// A single set of module mocks serves both the text suite (1 canned page, no
// VLM) and the hybrid suite (2 pages, figure reply). `beforeEach` resets
// these + call counts before every test so assertions stay hermetic.
let extractResult: { pageCount: number; pages: { pageNo: number; text: string }[] } = {
  pageCount: 1,
  pages: [{ pageNo: 1, text: CANNED_TEXT }],
};
let askReply = "";

const askMock = mock(() => Promise.resolve({ ok: true, reply: askReply }));
const visionMock = mock(async () => ({ output: "", ok: true }));
const extractCalls: { path: string; pages?: Set<number> | undefined }[] = [];
const rasterizeCalls: { input: string; outDir: string; opts: any }[] = [];

mock.module(`${ROOT}/src/native/pdftext.ts`, () => ({
  extractPdfText: (path: string, opts?: { pages?: Set<number> }) => {
    extractCalls.push({ path, pages: opts?.pages });
    return extractResult;
  },
}));

// T6 — rasterizePdf fake for the hybrid branch (figure-page rasterization).
// Writes real PNG bytes into the canonical pagesDir slot so any downstream
// readImage (should it run) finds valid bytes. Mirrors pipeline.test.ts.
mock.module(`${ROOT}/src/native/pdf2png.ts`, () => ({
  rasterizePdf: async (input: string, outDir: string, opts: any = {}) => {
    rasterizeCalls.push({ input, outDir, opts });
    mkdirSync(outDir, { recursive: true });
    const from = opts.fromPage ?? 1;
    const to = opts.toPage && opts.toPage > 0 ? opts.toPage : from;
    const width = 3; // matches pageLabel's max(3, …) for ≤999-page docs
    const pages: string[] = [];
    for (let p = from; p <= to; p++) {
      const file = join(outDir, `page-${String(p).padStart(width, "0")}.png`);
      writeFileSync(file, PNG_BYTES);
      pages.push(file);
    }
    return { pageCount: pages.length, pages };
  },
}));

// Per the task brief: mock askImage so we can assert the VLM primitive is never
// reached from the text branch, and IS reached exactly once for the hybrid
// figure page.
mock.module(`${ROOT}/src/vlm/ask.ts`, () => ({ askImage: askMock }));

// Defensive + non-vacuous: pipeline.ts's real VLM boundary is
// runVisionInference (via explainPage + classifyProfileFromPages), NOT askImage.
// Asserting this never fires proves the text branch short-circuits the VLM
// loop, and the hybrid branch routes figures through askImage (not
// vision-inference directly).
mock.module(`${ROOT}/src/vlm/vision-inference.ts`, () => ({
  runVisionInference: visionMock,
}));

// T5-fix regression guard: mirror the REAL resolveVisionLLM/resolveLLM
// no-model contract — THROW when invoked (ticket 01). Text tests keep this
// default ("throw") so a regression (eager resolve in text mode) propagates
// loudly. Hybrid tests NEED a resolved LLM (hybrid resolves eagerly since
// extract !== "text"), so they flip `resolveVisionMode` to "return". The text
// regression test still asserts `.not.toHaveBeenCalled()` — the loud throw is
// a second, stronger signal that survives.
const NO_MODEL_ERR =
  "[file2md] No model configured. Set model config via `/models-preset` (or `/workflows-models`), or export PI_MODEL as a temporary escape hatch.";
const STABLE_LLM = {
  provider: "lm-studio",
  modelId: "google/gemma-4-12b-qat",
  thinkingLevel: "off",
};
let resolveVisionMode: "throw" | "return" = "throw";
const resolveVisionLLMMock = mock(() => {
  if (resolveVisionMode === "throw") throw new Error(NO_MODEL_ERR);
  return STABLE_LLM;
});
const resolveLLMMock = mock(() => {
  throw new Error(NO_MODEL_ERR);
});
mock.module(`${ROOT}/src/sessions.ts`, () => ({
  resolveVisionLLM: resolveVisionLLMMock,
  resolveLLM: resolveLLMMock,
}));

// Import AFTER mocks are registered (same pattern as pipeline.test.ts).
const { runVlmDescribePipeline } = await import("../src/pipeline.ts");

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x35]; // %PDF-1.5

function setup() {
  const out = mkdtempSync(join(tmpdir(), "f2m-text-out-"));
  const inDir = mkdtempSync(join(tmpdir(), "f2m-text-in-"));
  const inputAbs = join(inDir, "doc.pdf");
  writeFileSync(inputAbs, Buffer.from(PDF_MAGIC));
  return { out, inputAbs };
}

/** Resolve the single generated slug directory under `out`. */
function slugDir(out: string): string {
  const kids = readdirSync(out).filter((n) => !n.endsWith(".json"));
  if (kids.length !== 1 || !kids[0]) {
    throw new Error(`expected exactly one slug dir under out, found: ${kids.join(", ")}`);
  }
  return kids[0];
}

// Reset all mock state between tests so call-count + return-value assertions
// are hermetic across the text + hybrid suites sharing these module mocks.
beforeEach(() => {
  extractCalls.length = 0;
  rasterizeCalls.length = 0;
  askMock.mockClear();
  visionMock.mockClear();
  resolveVisionLLMMock.mockClear();
  resolveLLMMock.mockClear();
  extractResult = { pageCount: 1, pages: [{ pageNo: 1, text: CANNED_TEXT }] };
  askReply = "";
  resolveVisionMode = "throw";
});

describe("runVlmDescribePipeline — extract=text", () => {
  it("writes per-page md from text extraction without calling the VLM", async () => {
    const { out, inputAbs } = setup();

    await runVlmDescribePipeline({
      inputs: [inputAbs],
      outRoot: out,
      extract: "text",
    });

    // No VLM call of any kind — the whole point of the text branch.
    expect(askMock).not.toHaveBeenCalled();
    expect(visionMock).not.toHaveBeenCalled();

    // extractPdfText was called once with the input path.
    expect(extractCalls).toHaveLength(1);
    expect(extractCalls[0]!.path).toBe(inputAbs);

    // Manifest reflects the text branch: pdf kind, paper profile (default),
    // single page marked done.
    const dir = slugDir(out);
    const manifest = JSON.parse(readFileSync(join(out, dir, "manifest.json"), "utf8"));
    expect(manifest.kind).toBe("pdf");
    expect(manifest.profile).toBe("paper");
    expect(manifest.pageCount).toBe(1);
    expect(manifest.pages[0].status).toBe("done");
    expect(manifest.pages[0].error).toBeUndefined();

    // Per-page markdown carries the extracted body + `kind: text` frontmatter,
    // and NO image embed (no rasterization happened).
    const md = readFileSync(join(out, dir, "pages", "page-001.md"), "utf8");
    expect(md).toContain(CANNED_TEXT);
    expect(md).toContain("kind: text");
    expect(md).toContain("page: 1");
    expect(md).not.toContain("![[");
  });

  it("emits page + doc_done events for parity with the vlm path", async () => {
    const { out, inputAbs } = setup();
    const events: any[] = [];

    await runVlmDescribePipeline({
      inputs: [inputAbs],
      outRoot: out,
      extract: "text",
      emit: (o) => events.push(o),
    });

    const types = events.map((e) => e.type);
    // No "classify" event (classifier skipped); page → doc_done only.
    expect(types).toEqual(["page", "doc_done"]);
    expect(events[0]).toMatchObject({ type: "page", status: "done", page: 1 });
    expect(events[1]).toMatchObject({ type: "doc_done", pages: 1 });
  });

  it("honors forcedType (overrides the default 'paper' profile)", async () => {
    const { out, inputAbs } = setup();

    await runVlmDescribePipeline({
      inputs: [inputAbs],
      outRoot: out,
      extract: "text",
      forcedType: "slides",
    });

    const dir = slugDir(out);
    const manifest = JSON.parse(readFileSync(join(out, dir, "manifest.json"), "utf8"));
    expect(manifest.profile).toBe("slides");
    // The per-page md `kind` stays "text" (extraction method), independent of
    // the doc-level profile.
    const md = readFileSync(join(out, dir, "pages", "page-001.md"), "utf8");
    expect(md).toContain("kind: text");
  });

  it("does NOT throw / does NOT resolve a VLM when no model is configured (Important fix)", async () => {
    // Reproduce the exact user text mode exists for: no model opt, no provider,
    // no PI_MODEL/PI_PROVIDER env. The REAL resolveVisionLLM throws
    // "[file2md] No model configured…" in this state (ticket 01), so text mode
    // MUST NOT reach it. The sessions mock above mirrors that throw — if the
    // Important fix regresses (eager resolve returns at the top of the run),
    // this test fails on both the propagated throw and the call-count check.
    const savedModel = process.env.PI_MODEL;
    const savedProvider = process.env.PI_PROVIDER;
    delete process.env.PI_MODEL;
    delete process.env.PI_PROVIDER;

    // Capture stderr to prove the `model:` log line is suppressed too.
    const lines: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => void lines.push(a.join(" "));

    const { out, inputAbs } = setup();
    try {
      await runVlmDescribePipeline({
        inputs: [inputAbs],
        outRoot: out,
        extract: "text",
        // deliberately NO model / provider / thinking opts
      });
    } finally {
      process.env.PI_MODEL = savedModel;
      process.env.PI_PROVIDER = savedProvider;
      console.error = origErr;
    }

    // The VLM resolver was never reached (the throwing mock would have fired).
    expect(resolveVisionLLMMock).not.toHaveBeenCalled();
    expect(resolveLLMMock).not.toHaveBeenCalled();
    // No `model:` log line in text mode (guarded alongside the resolve).
    expect(lines.some((l) => l.includes("model:"))).toBe(false);
    // And the run completed end-to-end: per-page md carries the extracted body.
    const dir = slugDir(out);
    const md = readFileSync(join(out, dir, "pages", "page-001.md"), "utf8");
    expect(md).toContain(CANNED_TEXT);
  });
});

describe("runVlmDescribePipeline — extract=hybrid", () => {
  // Two-page fixture: page 1 dense text-only (no figure token), page 2 sparse
  // AND naming "Figure 1". detectFigurePages → {2}, so ONLY page 2 is
  // rasterized + VLM-annotated; page 1 is pure mupdf text (like extract=text).
  const PAGE1_TEXT = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(4);
  const PAGE2_TEXT = "See Figure 1 below for the circuit diagram.";

  function stageTwoPages() {
    extractResult = {
      pageCount: 2,
      pages: [
        { pageNo: 1, text: PAGE1_TEXT },
        { pageNo: 2, text: PAGE2_TEXT },
      ],
    };
    askReply = FIGURE_REPLY;
    // Hybrid resolves the vision LLM eagerly (extract !== "text"); flip the
    // sessions mock from its throw default to a stable resolved target.
    resolveVisionMode = "return";
  }

  it("calls the VLM exactly once (figure page) and writes text+VLM md per page", async () => {
    stageTwoPages();
    const { out, inputAbs } = setup();

    await runVlmDescribePipeline({
      inputs: [inputAbs],
      outRoot: out,
      extract: "hybrid",
    });

    // --- VLM boundary: figure page ONLY -----------------------------------
    // askImage fires exactly once (page 2); vision-inference is never reached
    // because ask.ts is mocked end-to-end (describeFigureWithPrior → askImage).
    expect(askMock).toHaveBeenCalledTimes(1);
    expect(visionMock).not.toHaveBeenCalled();

    // --- text extraction: whole doc, once ---------------------------------
    expect(extractCalls).toHaveLength(1);
    expect(extractCalls[0]!.path).toBe(inputAbs);
    // Hybrid extracts ALL pages (no pages filter) so detectFigurePages has a
    // stable median baseline; the `only` filter is applied in the write loop.
    expect(extractCalls[0]!.pages).toBeUndefined();

    // --- rasterization: figure page ONLY ----------------------------------
    expect(rasterizeCalls).toHaveLength(1);
    expect(rasterizeCalls[0]!.opts.fromPage).toBe(2);
    expect(rasterizeCalls[0]!.opts.toPage).toBe(2);

    const dir = slugDir(out);

    // --- page 1: text-only ------------------------------------------------
    const md1 = readFileSync(join(out, dir, "pages", "page-001.md"), "utf8");
    expect(md1).toContain("kind: text");
    expect(md1).toContain("page: 1");
    expect(md1).toContain(PAGE1_TEXT);
    // NO VLM annotation on a text-only page.
    expect(md1).not.toContain("### Figures & equations (via VLM)");
    expect(md1).not.toContain(FIGURE_REPLY);

    // --- page 2: hybrid (prior text + VLM figure annotation) --------------
    const md2 = readFileSync(join(out, dir, "pages", "page-002.md"), "utf8");
    expect(md2).toContain("kind: hybrid");
    expect(md2).toContain("page: 2");
    expect(md2).toContain(PAGE2_TEXT); // prior text preserved as the body
    expect(md2).toContain("### Figures & equations (via VLM)");
    expect(md2).toContain(FIGURE_REPLY); // VLM annotation appended

    // --- manifest: both pages done, png honest ----------------------------
    const manifest = JSON.parse(readFileSync(join(out, dir, "manifest.json"), "utf8"));
    expect(manifest.kind).toBe("pdf");
    expect(manifest.profile).toBe("paper");
    expect(manifest.pageCount).toBe(2);
    expect(manifest.pages[0].status).toBe("done");
    expect(manifest.pages[1].status).toBe("done");
    // Text-only page: never rasterized → png nulled (manifest stays honest).
    expect(manifest.pages[0].png).toBeNull();
    // Figure page: rasterized on demand → canonical png path recorded.
    expect(manifest.pages[1].png).toMatch(/page-002\.png$/);
    // And the figure page PNG was actually written by the rasterize fake.
    expect(existsSync(join(out, dir, manifest.pages[1].png))).toBe(true);
  });

  it("emits page + doc_done events with no classify event (profile forced)", async () => {
    stageTwoPages();
    const { out, inputAbs } = setup();
    const events: any[] = [];

    await runVlmDescribePipeline({
      inputs: [inputAbs],
      outRoot: out,
      extract: "hybrid",
      emit: (o) => events.push(o),
    });

    const types = events.map((e) => e.type);
    // No "classify" event (classifier skipped — hybrid is profile-agnostic,
    // like text); two page events (in order) then doc_done.
    expect(types).toEqual(["page", "page", "doc_done"]);
    expect(events[0]).toMatchObject({ type: "page", status: "done", page: 1 });
    expect(events[1]).toMatchObject({ type: "page", status: "done", page: 2 });
    expect(events[2]).toMatchObject({ type: "doc_done", pages: 2 });
    // Only the figure page touched the VLM.
    expect(askMock).toHaveBeenCalledTimes(1);
  });

  it("honors forcedType (overrides the default 'paper' profile)", async () => {
    stageTwoPages();
    const { out, inputAbs } = setup();

    await runVlmDescribePipeline({
      inputs: [inputAbs],
      outRoot: out,
      extract: "hybrid",
      forcedType: "slides",
    });

    const dir = slugDir(out);
    const manifest = JSON.parse(readFileSync(join(out, dir, "manifest.json"), "utf8"));
    expect(manifest.profile).toBe("slides");
    // Per-page `kind` reflects the extraction method, not the doc profile.
    const md2 = readFileSync(join(out, dir, "pages", "page-002.md"), "utf8");
    expect(md2).toContain("kind: hybrid");
  });
});
