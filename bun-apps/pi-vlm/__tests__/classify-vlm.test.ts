/**
 * classify-vlm.ts — pure parser + the VLM classifier I/O.
 *
 * parseProfileReply is pure (tolerant matching of the model's reply into a
 * known DocProfile). classifyProfileViaVlm is the single-turn model call;
 * we mock ../src/sessions.ts so createSharedSession returns a controllable
 * fake session — no LM Studio / network.
 *
 * bun isolates each test FILE in its own process, so the module mock here
 * does not leak into sessions.test.ts (which exercises the real resolveLLM).
 *
 *   bun test __tests__/classify-vlm.test.ts
 */
import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// --- control knobs for the mocked session -----------------------------------
let subscriber: ((event: any) => void) | null = null;
let nextDeltas: string[] = [];
let nextError: Error | null = null;
const promptCalls: { text: string; imageCount: number; mimeType: string }[] = [];
const sessionOpts: { llm: any; opts: any }[] = [];

const SESSIONS_PATH = import.meta.dirname + "/../src/sessions.ts";

mock.module(SESSIONS_PATH, () => ({
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
  // Keep the real resolveLLM semantics out of the loop — return a stable target.
  resolveLLM: (o: any = {}) => ({
    provider: o?.provider ?? "lm-studio",
    modelId: o?.model ?? "mock/model",
    thinkingLevel: o?.thinking ?? "off",
  }),
}));

// Import AFTER the mock is registered.
const { classifyProfileViaVlm } = await import("../src/vlm/classify-vlm.ts");
const { parseProfileReply } = await import("../src/vlm/classify-vlm.ts");
const { resolveLLM } = await import("../src/sessions.ts");

let dir: string;
let imgPath: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pivlm-cv-"));
  imgPath = join(dir, "page-001.png");
  await writeFile(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function reset(overrides: { deltas?: string[]; error?: Error | null } = {}) {
  nextDeltas = overrides.deltas ?? [];
  nextError = overrides.error ?? null;
  promptCalls.length = 0;
  sessionOpts.length = 0;
  subscriber = null;
}

describe("parseProfileReply", () => {
  test("exact lowercase token → that profile", () => {
    expect(parseProfileReply("paper")).toBe("paper");
    expect(parseProfileReply("slides")).toBe("slides");
    expect(parseProfileReply("poster")).toBe("poster");
    expect(parseProfileReply("diagram")).toBe("diagram");
    expect(parseProfileReply("image")).toBe("image");
  });

  test("case-insensitive + surrounding noise tolerated", () => {
    expect(parseProfileReply("I think this is a PAPER.")).toBe("paper");
    expect(parseProfileReply("\n  Slides  \n")).toBe("slides");
  });

  test("first match wins in ALL_PROFILES order when reply names several", () => {
    // "paper" precedes "image" in ALL_PROFILES, so a reply mentioning both → paper.
    expect(parseProfileReply("paper or image")).toBe("paper");
  });

  test("unrecognized reply → image fallback (never throws)", () => {
    expect(parseProfileReply("zzzzz")).toBe("image");
    expect(parseProfileReply("")).toBe("image");
  });
});

describe("classifyProfileViaVlm — I/O (mocked session)", () => {
  test("happy path: streams a profile token and parses it", async () => {
    reset({ deltas: ["paper"] });
    const r = await classifyProfileViaVlm(imgPath, "image/png");
    expect(r.profile).toBe("paper");
    expect(r.reply).toBe("paper");
  });

  test("noisier reply is still parsed via parseProfileReply", async () => {
    reset({ deltas: ["This looks like ", "slides", " to me"] });
    const r = await classifyProfileViaVlm(imgPath, "image/png");
    expect(r.profile).toBe("slides");
    expect(r.reply).toBe("This looks like slides to me");
  });

  test("garbage reply falls back to image", async () => {
    reset({ deltas: ["not-a-profile"] });
    const r = await classifyProfileViaVlm(imgPath, "image/png");
    expect(r.profile).toBe("image");
  });

  test("attaches the image with the given mime type + uses the classifier prompt", async () => {
    reset({ deltas: ["diagram"] });
    await classifyProfileViaVlm(imgPath, "image/png");
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0]!.imageCount).toBe(1);
    expect(promptCalls[0]!.mimeType).toBe("image/png");
    expect(promptCalls[0]!.text.includes("只輸出一個 profile 代碼")).toBe(true);
  });

  test("llmOverride is forwarded verbatim to createSharedSession (resolveLLM NOT called)", async () => {
    reset({ deltas: ["poster"] });
    // Build the override directly — resolveLLM is mocked here, so calling it
    // would only exercise the mock. The contract under test is "the object the
    // caller passes becomes the session's llm, untouched".
    const explicit = {
      provider: "anthropic",
      modelId: "claude-x",
      thinkingLevel: "off" as const,
    };
    await classifyProfileViaVlm(imgPath, "image/jpeg", explicit);
    expect(sessionOpts).toHaveLength(1);
    expect(sessionOpts[0]!.llm).toBe(explicit);
    expect(sessionOpts[0]!.llm.provider).toBe("anthropic");
  });

  test("no override → resolveLLM({}) default target is used", async () => {
    reset({ deltas: ["paper"] });
    await classifyProfileViaVlm(imgPath, "image/png");
    expect(sessionOpts).toHaveLength(1);
    expect(sessionOpts[0]!.llm.provider).toBe("lm-studio");
    expect(sessionOpts[0]!.llm.modelId).toBe("mock/model");
  });

  test("prompt error propagates (classifier does not swallow model errors)", async () => {
    reset({ deltas: [], error: new Error("503 overloaded") });
    await expect(classifyProfileViaVlm(imgPath, "image/png")).rejects.toThrow(
      "503 overloaded",
    );
  });
});
