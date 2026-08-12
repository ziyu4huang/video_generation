/**
 * pipeline.ts — runVlmDescribePipeline end-to-end.
 *
 * The orchestrator ties together: classifyKind → rasterize/copy → manifest →
 * classifyProfileViaVlm → per-page explainPage → manifest + MOC index note.
 *
 * Mock surface kept to the TWO boundary modules no other test file imports for
 * real: `native/pdf2png.ts` (rasterizePdf) and `vlm/vision-inference.ts`
 * (runVisionInference — the model I/O). Everything else — the REAL
 * classify-vlm.ts (parses the reply into a profile), the REAL agents.ts
 * explainPage (normalizes the markdown), manifest.ts, classify.ts, retry.ts
 * and the filesystem — runs unmodified. So this file exercises the orchestrator
 * + the real per-call logic, with only the network/model boundary stubbed.
 *
 * The fake runVisionInference dispatches on the task text: the classifier
 * task yields a profile token, any other task yields a page-markdown blob.
 * The fake rasterizePdf writes real PNG bytes so the real readImageContent can
 * read them. No LM Studio / no GPU.
 *
 *   bun test __tests__/pipeline.test.ts
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- control knobs ----------------------------------------------------------
// What the fake model emits for the classifier turn and the per-page turn.
let classifyReply = "paper";
let classifyReplies: string[] = []; // S4: per-call queue for multi-page voting
let pageMarkdown =
  "---\ntitle: T\npage: 1\nkind: paper\n---\n\n![[page-001.png]]\n\nPAGE BODY with realistic content to clear the quality gate";
let rasterizePageCount = 1;
const rasterizeCalls: { input: string; pagesDir: string; dpi: number }[] = [];
const inferenceCalls: { task: string; images: any[]; llm: any; systemPrompt?: string }[] = [];

const ROOT = import.meta.dirname + "/..";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

mock.module(`${ROOT}/src/native/pdf2png.ts`, () => ({
  // Write real PNG bytes so the real explainPage/readImageContent can read them.
  rasterizePdf: async (input: string, pagesDir: string, opts: { dpi: number }) => {
    rasterizeCalls.push({ input, pagesDir, dpi: opts?.dpi });
    await mkdir(pagesDir, { recursive: true });
    const pages: string[] = [];
    const width = Math.max(3, String(rasterizePageCount).length);
    for (let p = 1; p <= rasterizePageCount; p++) {
      const rel = `pages/page-${String(p).padStart(width, "0")}.png`;
      const abs = join(join(pagesDir, ".."), rel); // pagesDir already ends in /pages
      // pagesDir IS the pages/ dir; place files directly inside it.
      const file = join(pagesDir, `page-${String(p).padStart(width, "0")}.png`);
      await writeFile(file, PNG_BYTES);
      pages.push(file);
    }
    return { pageCount: rasterizePageCount, pages };
  },
}));

mock.module(`${ROOT}/src/vlm/vision-inference.ts`, () => ({
  runVisionInference: async (opts: { task: string }) => {
    inferenceCalls.push(opts);
    const isClassify = opts.task.includes("分類") || opts.task.includes("profile 代碼");
    const payload = isClassify ? (classifyReplies.length ? classifyReplies.shift()! : classifyReply) : pageMarkdown;
    return { output: payload, ok: true };
  },
}));

// resolveVisionLLM/resolveLLM are de-hardcoded (ticket 01: throw when unconfigured).
// This is a pipeline-orchestration test, not a model-resolution test — stub the
// resolver to a stable target (realm-safe: this realm already mocks vision-inference).
mock.module(`${ROOT}/src/sessions.ts`, () => ({
  resolveVisionLLM: () => ({ provider: "lm-studio", modelId: "google/gemma-4-12b-qat", thinkingLevel: "off" }),
  resolveLLM: (opts: { provider?: string; model?: string; thinking?: string } = {}) => ({
    provider: opts.provider ?? "lm-studio",
    modelId: opts.model ?? "google/gemma-4-12b-qat",
    thinkingLevel: opts.thinking ?? "off",
  }),
}));

// Keep retries fast + bounded for the page-quality-gate retry test below.
// (pipeline.ts reads these lazily at call time, so they apply whenever the
// pipeline runs — not just at module load.)
process.env.PI_VLM_RETRIES = "1";
process.env.PI_VLM_RETRY_WAIT_MS = "0";

// Import AFTER the mocks are registered.
const { runVlmDescribePipeline } = await import("../src/pipeline.ts");

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x35];

const dirs: string[] = [];
async function setup(name: string, bytes: number[]) {
  const t = await mkdtemp(join(tmpdir(), "pivlm-pipe-"));
  dirs.push(t);
  const inputAbs = join(t, name);
  await writeFile(inputAbs, Buffer.from(bytes));
  return { t, inputAbs, outRoot: join(t, "out") };
}
beforeEach(() => {
  rasterizePageCount = 1;
  rasterizeCalls.length = 0;
  inferenceCalls.length = 0;
  classifyReply = "paper";
  classifyReplies = [];
  pageMarkdown =
    "---\ntitle: T\npage: 1\nkind: paper\n---\n\n![[page-001.png]]\n\nPAGE BODY with realistic content to clear the quality gate";
});
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
// NOTE on mock leakage: Bun's DEFAULT test mode shares one realm across multiple
// test files in a worker, so mock.module() here would clobber the real
// vision-inference.ts imported by other suites. Run the suite with
// `bun test --isolate` (set in this package's test script) so each file gets a
// fresh realm. mock.module() is realm-scoped under --isolate, eliminating the
// cross-file leak.

async function readJsonFile(p: string) {
  return JSON.parse(await readFile(p, "utf8"));
}

describe("runVlmDescribePipeline — validation", () => {
  test("empty inputs throws", async () => {
    const { outRoot } = await setup("x.png", PNG_MAGIC);
    await expect(runVlmDescribePipeline({ inputs: [], outRoot })).rejects.toThrow("No input files");
  });

  test("invalid forcedType throws and lists valid profiles", async () => {
    const { inputAbs, outRoot } = await setup("doc.png", PNG_MAGIC);
    await expect(runVlmDescribePipeline({ inputs: [inputAbs], outRoot, forcedType: "bogus" as any })).rejects.toThrow(
      /Invalid type "bogus"/,
    );
  });
});

describe("runVlmDescribePipeline — image happy path", () => {
  test("classifies via VLM, explains the page, writes manifest + md + index note", async () => {
    const { inputAbs, outRoot } = await setup("report.png", PNG_MAGIC);
    await runVlmDescribePipeline({ inputs: [inputAbs], outRoot });

    // At least one model inference ran (classifier + extraction).
    expect(inferenceCalls.length).toBeGreaterThanOrEqual(1);

    // manifest.json reflects the detected profile + done status.
    const manifest = await readJsonFile(join(outRoot, "report", "manifest.json"));
    expect(manifest.profile).toBe("paper");
    expect(manifest.kind).toBe("image");
    expect(manifest.pageCount).toBe(1);
    expect(manifest.pages[0].status).toBe("done");
    expect(manifest.pages[0].error).toBeUndefined();

    // Per-page markdown was written and normalized (page/kind overridden).
    const md = await readFile(join(outRoot, "report", "pages", "page-001.md"), "utf8");
    expect(md.startsWith("---\ntitle: T\npage: 1\nkind: paper\n---\n")).toBe(true);
    expect(md.includes("PAGE BODY")).toBe(true);

    // Index note (MOC) was written.
    const index = await readFile(join(outRoot, "report", "report.md"), "utf8");
    expect(index.includes("title: report.png")).toBe(true);
    expect(index.includes("profile: paper")).toBe(true);
    expect(index.includes("共 1 頁")).toBe(true);
    expect(index.includes("✅")).toBe(true); // done marker
  });

  test("pdf path: rasterizes via rasterizePdf with the configured dpi", async () => {
    rasterizePageCount = 2;
    const { inputAbs, outRoot } = await setup("doc.pdf", PDF_MAGIC);
    await runVlmDescribePipeline({
      inputs: [inputAbs],
      outRoot,
      dpi: 200,
      forcedType: "paper",
    });

    expect(rasterizeCalls).toHaveLength(1);
    expect(rasterizeCalls[0]!.dpi).toBe(200);
    expect(rasterizeCalls[0]!.input).toBe(inputAbs);

    // Both rasterized pages were explained + marked done.
    const manifest = await readJsonFile(join(outRoot, "doc", "manifest.json"));
    expect(manifest.pageCount).toBe(2);
    expect(manifest.pages.map((p: any) => p.status)).toEqual(["done", "done"]);
    // Both per-page md files exist.
    expect(existsSync(join(outRoot, "doc", "pages", "page-001.md"))).toBe(true);
    expect(existsSync(join(outRoot, "doc", "pages", "page-002.md"))).toBe(true);
  });
});

describe("runVlmDescribePipeline — forcedType", () => {
  test("forcedType skips the classifier and forces the profile", async () => {
    const { inputAbs, outRoot } = await setup("img.png", PNG_MAGIC);
    await runVlmDescribePipeline({ inputs: [inputAbs], outRoot, forcedType: "diagram" });

    // Only ONE inference call (extraction) — the classifier is skipped.
    expect(inferenceCalls).toHaveLength(1);

    const manifest = await readJsonFile(join(outRoot, "img", "manifest.json"));
    expect(manifest.profile).toBe("diagram");
    // The per-page md kind field was overridden to the forced profile.
    const md = await readFile(join(outRoot, "img", "pages", "page-001.md"), "utf8");
    expect(md.includes("kind: diagram")).toBe(true);
  });
});

describe("runVlmDescribePipeline — classifier failure", () => {
  test("an unrecognized classifier reply defaults the profile by kind (image → image)", async () => {
    // The model returns garbage; parseProfileReply falls back to "image", which
    // the pipeline accepts (no throw). kind===image keeps profile image.
    classifyReply = "zzzzz-not-a-profile";
    const { inputAbs, outRoot } = await setup("photo.png", PNG_MAGIC);
    await runVlmDescribePipeline({ inputs: [inputAbs], outRoot });

    const manifest = await readJsonFile(join(outRoot, "photo", "manifest.json"));
    expect(manifest.profile).toBe("image");
  });
});

describe("runVlmDescribePipeline — page quality gate (S2)", () => {
  test("a page failing the gate is retried then marked error with the gate reason", async () => {
    // Garbage: no frontmatter, no embed, tiny body → fails the gate every time.
    pageMarkdown = "lol not markdown at all";
    const { inputAbs, outRoot } = await setup("doc.png", PNG_MAGIC);
    await runVlmDescribePipeline({ inputs: [inputAbs], outRoot, forcedType: "paper" });

    const manifest = await readJsonFile(join(outRoot, "doc", "manifest.json"));
    expect(manifest.pages[0].status).toBe("error");
    expect(manifest.pages[0].error).toMatch(/gate:/);
    // A failed page must not have its md written.
    expect(existsSync(join(outRoot, "doc", "pages", "page-001.md"))).toBe(false);
  });
});

describe("runVlmDescribePipeline — resume", () => {
  test("a second run reuses the existing manifest and skips already-done pages", async () => {
    const { inputAbs, outRoot } = await setup("doc.png", PNG_MAGIC);

    await runVlmDescribePipeline({ inputs: [inputAbs], outRoot });
    const inferencesAfterFirst = inferenceCalls.length;

    // Second run on the same outRoot: page is already done + md exists.
    await runVlmDescribePipeline({ inputs: [inputAbs], outRoot });
    // No NEW model inferences on the second run (classifier reused, page skipped).
    expect(inferenceCalls.length).toBe(inferencesAfterFirst);

    expect(existsSync(join(outRoot, "doc", "pages", "page-001.md"))).toBe(true);
  });
});

describe("runVlmDescribePipeline — page spec", () => {
  test("pages spec selects a subset of pages", async () => {
    rasterizePageCount = 3;
    const { inputAbs, outRoot } = await setup("doc.pdf", PDF_MAGIC);
    await runVlmDescribePipeline({
      inputs: [inputAbs],
      outRoot,
      pages: "1,3",
      forcedType: "paper",
    });

    const manifest = await readJsonFile(join(outRoot, "doc", "manifest.json"));
    expect(manifest.pages.map((p: any) => p.status)).toEqual(["done", "pending", "done"]);
    // Only pages 1 and 3 got md; page 2 did not.
    expect(existsSync(join(outRoot, "doc", "pages", "page-001.md"))).toBe(true);
    expect(existsSync(join(outRoot, "doc", "pages", "page-002.md"))).toBe(false);
    expect(existsSync(join(outRoot, "doc", "pages", "page-003.md"))).toBe(true);
  });

  test("pages spec matching no pages throws a helpful 1-indexed hint", async () => {
    rasterizePageCount = 1;
    const { inputAbs, outRoot } = await setup("doc.pdf", PDF_MAGIC);
    await expect(
      runVlmDescribePipeline({
        inputs: [inputAbs],
        outRoot,
        pages: "9",
        forcedType: "paper",
      }),
    ).rejects.toThrow(/matched no pages/);
  });
});

describe("runVlmDescribePipeline — parallel pages (T2)", () => {
  test("concurrency>1 processes all pages with a consistent manifest", async () => {
    rasterizePageCount = 3;
    const { inputAbs, outRoot } = await setup("doc.pdf", PDF_MAGIC);
    await runVlmDescribePipeline({
      inputs: [inputAbs],
      outRoot,
      forcedType: "paper",
      concurrency: 3,
    });

    const manifest = await readJsonFile(join(outRoot, "doc", "manifest.json"));
    expect(manifest.pages.map((p: any) => p.status)).toEqual(["done", "done", "done"]);
    for (const p of [1, 2, 3]) {
      expect(existsSync(join(outRoot, "doc", "pages", `page-${String(p).padStart(3, "0")}.md`))).toBe(true);
    }
  });

  test("parallel mode is resumable (done pages skipped on re-run)", async () => {
    rasterizePageCount = 2;
    const { inputAbs, outRoot } = await setup("doc.pdf", PDF_MAGIC);
    await runVlmDescribePipeline({
      inputs: [inputAbs],
      outRoot,
      forcedType: "paper",
      concurrency: 2,
    });
    const inferencesAfterFirst = inferenceCalls.length;
    await runVlmDescribePipeline({
      inputs: [inputAbs],
      outRoot,
      forcedType: "paper",
      concurrency: 2,
    });
    // No new model inferences on re-run (classifier reused, pages done).
    expect(inferenceCalls.length).toBe(inferencesAfterFirst);
  });
});

describe("runVlmDescribePipeline — multi-page classification vote (S4)", () => {
  test("samples first/middle/last and majority-votes the profile", async () => {
    rasterizePageCount = 3;
    classifyReplies = ["poster", "paper", "paper"]; // page1 poster, mid paper, last paper
    const { inputAbs, outRoot } = await setup("doc.pdf", PDF_MAGIC);
    await runVlmDescribePipeline({ inputs: [inputAbs], outRoot });

    const manifest = await readJsonFile(join(outRoot, "doc", "manifest.json"));
    expect(manifest.profile).toBe("paper"); // majority over the cover-page poster vote
    expect(manifest.kind).toBe("pdf");
  });

  test("votes are emitted joined in the classify event", async () => {
    rasterizePageCount = 2;
    classifyReplies = ["slides", "slides"];
    const { inputAbs, outRoot } = await setup("doc.pdf", PDF_MAGIC);
    const events: any[] = [];
    await runVlmDescribePipeline({ inputs: [inputAbs], outRoot, emit: (o) => events.push(o) });
    const classifyEv = events.find((e) => e.type === "classify");
    expect(classifyEv.profile).toBe("slides");
    expect(classifyEv.reply).toContain("slides / slides");
  });
});

describe("runVlmDescribePipeline — emit", () => {
  test("emit fires classify → page → doc_done events", async () => {
    const { inputAbs, outRoot } = await setup("doc.png", PNG_MAGIC);
    const events: any[] = [];
    await runVlmDescribePipeline({ inputs: [inputAbs], outRoot, emit: (o) => events.push(o) });

    const types = events.map((e) => e.type);
    expect(types).toEqual(["classify", "page", "doc_done"]);
    expect(events[0]).toMatchObject({ type: "classify", slug: "doc", profile: "paper" });
    expect(events[1]).toMatchObject({ type: "page", slug: "doc", page: 1, status: "done" });
    expect(events[2]).toMatchObject({ type: "doc_done", slug: "doc", pages: 1 });
  });
});
