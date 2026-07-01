/**
 * explainPage I/O — the per-page VLM extraction call in src/vlm/agents.ts.
 *
 * explainPage drives a one-turn session, accumulates streamed text deltas, and
 * runs normalizeEmbeds + normalizeFrontmatter on the result before returning.
 * The pure normalizers are pinned in agents.test.ts; here we verify the I/O
 * wiring (subscribe/prompt/dispose) AND that the streamed markdown actually
 * flows through the normalizers end-to-end. ../src/sessions.ts is mocked.
 *
 *   bun test __tests__/explain-page.test.ts
 */
import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// --- control knobs ----------------------------------------------------------
let subscriber: ((event: any) => void) | null = null;
let nextDeltas: string[] = [];
let nextError: Error | null = null;
const sessionOpts: { llm: any; opts: any }[] = [];
const promptCalls: { text: string; imageCount: number; mimeType: string }[] = [];

mock.module(import.meta.dirname + "/../src/sessions.ts", () => ({
  createSharedSession: async (llm: any, opts: any) => {
    sessionOpts.push({ llm, opts });
    return {
      session: {
        subscribe: (cb: (e: any) => void) => {
          subscriber = cb;
          return () => {
            subscriber = null;
          };
        },
        prompt: async (text: string, opts: any) => {
          promptCalls.push({
            text,
            imageCount: opts?.images?.length ?? 0,
            mimeType: opts?.images?.[0]?.mimeType ?? "",
          });
          for (const d of nextDeltas) {
            subscriber?.({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: d },
            });
          }
          if (nextError) throw nextError;
        },
        dispose: () => {},
      },
    };
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

function reset(overrides: { deltas?: string[]; error?: Error | null } = {}) {
  nextDeltas = overrides.deltas ?? [];
  nextError = overrides.error ?? null;
  sessionOpts.length = 0;
  promptCalls.length = 0;
  subscriber = null;
}

describe("explainPage — I/O (mocked session)", () => {
  test("happy path: streamed deltas → normalized markdown, ok:true", async () => {
    // The VLM emits a WRONG page/kind; our override must win.
    reset({
      deltas: [
        "---\ntitle: T\npage: 99\nkind: fake\n---\n\n![[page-001.png]]\n\nbody text",
      ],
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
      deltas: [
        "---\ntitle: T\npage: 1\nkind: paper\n---\n\n![[<page-001.png>]]\n\nbody",
      ],
    });
    const r = await explainPage(LLM, "paper", page());
    expect(r.ok).toBe(true);
    expect(r.markdown.includes("![[page-001.png]]")).toBe(true);
    expect(r.markdown.includes("<page-001.png>")).toBe(false);
  });

  test("repair: UNCLOSED frontmatter from the stream gets closed + overridden", async () => {
    reset({
      deltas: [
        "---\ntitle: T\npage: 99\nkind: fake\n\n![[page-001.png]]\n\nbody",
      ],
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

  test("profile selects the system prompt via appendSystemPrompt", async () => {
    reset({ deltas: ["x"] });
    await explainPage(LLM, "slides", page());
    const sys = sessionOpts[0]!.opts.appendSystemPrompt;
    expect(Array.isArray(sys)).toBe(true);
    expect(sys).toHaveLength(1);
    // slides-specific marker
    expect(sys[0].includes("kind 欄位固定為 slides")).toBe(true);
  });

  test("prompt receives the page user message (slug + embed line + page no)", async () => {
    reset({ deltas: ["x"] });
    await explainPage(LLM, "image", page());
    const text = promptCalls[0]!.text;
    expect(text.includes("my-doc")).toBe(true);
    expect(text.includes("第 1 頁")).toBe(true);
    expect(text.includes("共 5 頁")).toBe(true);
    expect(text.includes("![[page-001.png]]")).toBe(true);
  });

  test("attaches exactly one image with the given mime type", async () => {
    reset({ deltas: ["x"] });
    await explainPage(LLM, "image", page());
    expect(promptCalls[0]!.imageCount).toBe(1);
    expect(promptCalls[0]!.mimeType).toBe("image/png");
  });

  test("prompt error is swallowed into ok:false + empty markdown (no throw)", async () => {
    reset({ error: new Error("model 500") });
    const r = await explainPage(LLM, "paper", page());
    expect(r.ok).toBe(false);
    expect(r.markdown).toBe("");
    expect(r.error).toBe("model 500");
  });

  test("llm is forwarded verbatim to createSharedSession", async () => {
    reset({ deltas: ["x"] });
    await explainPage(LLM, "paper", page());
    expect(sessionOpts[0]!.llm).toBe(LLM);
  });
});
