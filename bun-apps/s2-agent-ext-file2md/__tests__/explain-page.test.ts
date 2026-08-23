/**
 * explainPage I/O — the per-page VLM extraction call in src/vlm/agents.ts.
 *
 * explainPage drives a single runVisionInference call + runs normalizeEmbeds +
 * normalizeFrontmatter on the result before returning. The pure normalizers
 * are pinned in agents.test.ts; here we verify the I/O wiring (task/images/
 * systemPrompt forwarded) AND that the returned markdown actually flows through
 * the normalizers end-to-end. ../src/vlm/vision-inference.ts is mocked.
 *
 *   bun test __tests__/explain-page.test.ts
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- control knobs ----------------------------------------------------------
let nextOutput = "";
let nextError: string | undefined;
const inferenceCalls: {
  task: string;
  images: any[];
  llm: any;
  systemPrompt?: string;
}[] = [];

mock.module(`${import.meta.dirname}/../src/vlm/vision-inference.ts`, () => ({
  runVisionInference: async (opts: any) => {
    inferenceCalls.push(opts);
    if (nextError !== undefined) return { output: "", ok: false, error: nextError };
    return { output: nextOutput, ok: true };
  },
}));

const { explainPage } = await import("../src/vlm/agents.ts");

const LLM = { provider: "lm-studio", modelId: "mock/model", thinkingLevel: "off" as const };

let dir: string;
let imgPath: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pivlm-ep-"));
  imgPath = join(dir, "page-001.png");
  await writeFile(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Built as a function so imageAbs picks up the temp path AFTER beforeAll runs
// (a top-level const would freeze imgPath = undefined at module-eval time).
const page = () => ({
  imageAbs: imgPath,
  mimeType: "image/png",
  pngLinkName: "page-001.png",
  docSlug: "my-doc",
  pageNo: 1,
  pageCount: 5,
});

function reset(overrides: { output?: string; error?: string | null } = {}) {
  nextOutput = overrides.output ?? "";
  nextError = overrides.error ?? undefined;
  inferenceCalls.length = 0;
}

describe("explainPage — I/O (mocked vision-inference)", () => {
  test("happy path: output → normalized markdown, ok:true", async () => {
    // The VLM emits a WRONG page/kind; our override must win.
    reset({
      output: "---\ntitle: T\npage: 99\nkind: fake\n---\n\n![[page-001.png]]\n\nbody text",
    });
    const r = await explainPage(LLM, "paper", page());
    expect(r.ok).toBe(true);
    expect(r.markdown.startsWith("---\ntitle: T\npage: 1\nkind: paper\n---\n")).toBe(true);
    expect(r.markdown.includes("![[page-001.png]]")).toBe(true);
    expect(r.markdown.includes("page: 99")).toBe(false);
    expect(r.markdown.includes("kind: fake")).toBe(false);
  });

  test("repair: stray angle brackets in the embed are stripped end-to-end", async () => {
    reset({
      output: "---\ntitle: T\npage: 1\nkind: paper\n---\n\n![[<page-001.png>]]\n\nbody",
    });
    const r = await explainPage(LLM, "paper", page());
    expect(r.ok).toBe(true);
    expect(r.markdown.includes("![[page-001.png]]")).toBe(true);
    expect(r.markdown.includes("<page-001.png>")).toBe(false);
  });

  test("repair: UNCLOSED frontmatter from the output gets closed + overridden", async () => {
    reset({
      output: "---\ntitle: T\npage: 99\nkind: fake\n\n![[page-001.png]]\n\nbody",
    });
    const r = await explainPage(LLM, "paper", page());
    expect(r.ok).toBe(true);
    // Closed (two --- delimiters) and overridden.
    const lines = r.markdown.split("\n");
    expect(lines[0]).toBe("---");
    const secondDelim = lines.indexOf("---", 1);
    expect(secondDelim).toBeGreaterThan(0);
    expect(r.markdown.includes("page: 1")).toBe(true);
    expect(r.markdown.includes("kind: paper")).toBe(true);
  });

  test("profile selects the system prompt (forwarded as systemPrompt string)", async () => {
    reset({ output: "x" });
    await explainPage(LLM, "slides", page());
    const sys = inferenceCalls[0]?.systemPrompt;
    expect(typeof sys).toBe("string");
    // slides-specific marker
    expect(sys?.includes("kind 欄位固定為 slides")).toBe(true);
  });

  test("task receives the page user message (slug + embed line + page no)", async () => {
    reset({ output: "x" });
    await explainPage(LLM, "image", page());
    const text = inferenceCalls[0]?.task;
    expect(text.includes("my-doc")).toBe(true);
    expect(text.includes("第 1 頁")).toBe(true);
    expect(text.includes("共 5 頁")).toBe(true);
    expect(text.includes("![[page-001.png]]")).toBe(true);
  });

  test("attaches exactly one image with the given mime type", async () => {
    reset({ output: "x" });
    await explainPage(LLM, "image", page());
    expect(inferenceCalls[0]?.images).toHaveLength(1);
    expect(inferenceCalls[0]?.images[0]?.mimeType).toBe("image/png");
  });

  test("inference error is swallowed into ok:false + empty markdown (no throw)", async () => {
    reset({ error: "model 500" });
    const r = await explainPage(LLM, "paper", page());
    expect(r.ok).toBe(false);
    expect(r.markdown).toBe("");
    expect(r.error).toBe("model 500");
  });

  test("llm is forwarded verbatim to runVisionInference", async () => {
    reset({ output: "x" });
    await explainPage(LLM, "paper", page());
    expect(inferenceCalls[0]?.llm).toBe(LLM);
  });
});
