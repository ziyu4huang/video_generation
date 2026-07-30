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
 *   - `sessions.ts`        → `resolveVisionLLM` stub (the eager call at the top
 *                           of the run would otherwise throw w/o model config)
 *
 * The fake input is a minimal `%PDF-1.5` magic-bytes file: `classifyKind`
 * sniffs the first bytes → kind "pdf", but since the text branch skips
 * `prepareDoc`, `rasterizePdf` is never asked to actually render it.
 *
 *   bun test --isolate __tests__/pipeline-extract.test.ts
 */
import { describe, it, expect, mock } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = import.meta.dirname + "/..";

// --- sentinels --------------------------------------------------------------
const askMock = mock(() => Promise.resolve({ ok: true, reply: "" }));
const visionMock = mock(async () => ({ output: "", ok: true }));
const extractCalls: { path: string; pages?: Set<number> | undefined }[] = [];

// Canned extraction result: one page, deterministic body.
const CANNED_TEXT = "HELLO BODY";

mock.module(`${ROOT}/src/native/pdftext.ts`, () => ({
  extractPdfText: (path: string, opts?: { pages?: Set<number> }) => {
    extractCalls.push({ path, pages: opts?.pages });
    return {
      pageCount: 1,
      pages: [{ pageNo: 1, text: CANNED_TEXT }],
    };
  },
}));

// Per the task brief: mock askImage so we can assert the VLM primitive is never
// reached from the text branch.
mock.module(`${ROOT}/src/vlm/ask.ts`, () => ({ askImage: askMock }));

// Defensive + non-vacuous: pipeline.ts's real VLM boundary is
// runVisionInference (via explainPage + classifyProfileFromPages), NOT askImage.
// Asserting this never fires proves the text branch short-circuits the VLM loop.
mock.module(`${ROOT}/src/vlm/vision-inference.ts`, () => ({
  runVisionInference: visionMock,
}));

// The eager `resolveVisionLLM(...)` at the top of runVlmDescribePipeline would
// throw without model config (ticket 01). Stub it — this is an extraction-flow
// test, not a model-resolution test.
mock.module(`${ROOT}/src/sessions.ts`, () => ({
  resolveVisionLLM: () => ({
    provider: "lm-studio",
    modelId: "google/gemma-4-12b-qat",
    thinkingLevel: "off",
  }),
  resolveLLM: () => ({
    provider: "lm-studio",
    modelId: "google/gemma-4-12b-qat",
    thinkingLevel: "off",
  }),
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
});
