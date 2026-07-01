/**
 * askImage I/O — the single-turn "ask a VLM about one image" primitive.
 *
 * The pure helper guessImageMimeType is already covered by src/vlm/ask.test.ts;
 * here we cover the session-driving askImage() itself. ../src/sessions.ts is
 * mocked so createSharedSession returns a controllable fake session — no
 * LM Studio / network. File isolation keeps this mock out of the other suites.
 *
 *   bun test __tests__/ask-io.test.ts
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
  resolveLLM: (o: any = {}) => ({
    provider: o?.provider ?? "lm-studio",
    modelId: o?.model ?? "mock/model",
    thinkingLevel: o?.thinking ?? "off",
  }),
}));

const { askImage } = await import("../src/vlm/ask.ts");

let dir: string;
let pngPath: string;
let jpgPath: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pivlm-ask-"));
  pngPath = join(dir, "photo.png");
  jpgPath = join(dir, "photo.jpg");
  await writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(jpgPath, Buffer.from([0xff, 0xd8, 0xff]));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function reset(overrides: { deltas?: string[]; error?: Error | null } = {}) {
  nextDeltas = overrides.deltas ?? [];
  nextError = overrides.error ?? null;
  sessionOpts.length = 0;
  promptCalls.length = 0;
  subscriber = null;
}

describe("askImage — I/O (mocked session)", () => {
  test("happy path: streamed deltas are concatenated + outer-trimmed into reply", async () => {
    reset({ deltas: ["  a landscape", " photo.  "] });
    const r = await askImage(pngPath, "describe this");
    expect(r.ok).toBe(true);
    expect(r.reply).toBe("a landscape photo.");
    expect(r.error).toBeUndefined();
  });

  test("passes the question verbatim as the prompt text", async () => {
    reset({ deltas: ["x"] });
    await askImage(pngPath, "what color is the sky?");
    expect(promptCalls[0]!.text).toBe("what color is the sky?");
  });

  test("attaches exactly one image", async () => {
    reset({ deltas: ["x"] });
    await askImage(pngPath, "q");
    expect(promptCalls[0]!.imageCount).toBe(1);
  });

  test("mime defaults via guessImageMimeType for .jpg", async () => {
    reset({ deltas: ["x"] });
    await askImage(jpgPath, "q");
    expect(promptCalls[0]!.mimeType).toBe("image/jpeg");
  });

  test("explicit mimeType opt overrides the extension guess", async () => {
    reset({ deltas: ["x"] });
    await askImage(pngPath, "q", { mimeType: "image/webp" });
    expect(promptCalls[0]!.mimeType).toBe("image/webp");
  });

  test("systemPrompt is wrapped as a single-element appendSystemPrompt", async () => {
    reset({ deltas: ["x"] });
    await askImage(pngPath, "q", { systemPrompt: "answer in one line" });
    expect(sessionOpts[0]!.opts.appendSystemPrompt).toEqual(["answer in one line"]);
  });

  test("no systemPrompt → appendSystemPrompt is undefined (no empty array)", async () => {
    reset({ deltas: ["x"] });
    await askImage(pngPath, "q");
    expect(sessionOpts[0]!.opts.appendSystemPrompt).toBeUndefined();
  });

  test("agentDir is forwarded to createSharedSession", async () => {
    reset({ deltas: ["x"] });
    await askImage(pngPath, "q", { agentDir: "/proj/.pi/agent" });
    expect(sessionOpts[0]!.opts.agentDir).toBe("/proj/.pi/agent");
  });

  test("explicit llm override is used as-is (no resolveLLM defaulting)", async () => {
    reset({ deltas: ["x"] });
    const llm = { provider: "zai", modelId: "glm-vlm", thinkingLevel: "off" as const };
    await askImage(pngPath, "q", { llm });
    expect(sessionOpts[0]!.llm).toBe(llm);
  });

  test("no llm → resolveLLM({}) default target", async () => {
    reset({ deltas: ["x"] });
    await askImage(pngPath, "q");
    expect(sessionOpts[0]!.llm.provider).toBe("lm-studio");
    expect(sessionOpts[0]!.llm.modelId).toBe("mock/model");
  });

  test("prompt error is swallowed into ok:false + error (no throw)", async () => {
    reset({ error: new Error("connection reset") });
    const r = await askImage(pngPath, "q");
    expect(r.ok).toBe(false);
    expect(r.reply).toBe("");
    expect(r.error).toBe("connection reset");
  });

  test("empty reply is still ok:true (a valid empty answer)", async () => {
    reset({ deltas: [] });
    const r = await askImage(pngPath, "q");
    expect(r.ok).toBe(true);
    expect(r.reply).toBe("");
  });
});
