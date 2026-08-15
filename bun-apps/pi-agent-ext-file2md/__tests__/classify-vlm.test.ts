/**
 * classify-vlm.ts — pure parser + the VLM classifier I/O.
 *
 * parseProfileReply is pure (tolerant matching of the model's reply into a
 * known DocProfile). classifyProfileViaVlm is the single-turn model call;
 * we mock ../src/vlm/vision-inference.ts so runVisionInference returns a
 * controllable fake result — no spawnSubagent / LM Studio / network.
 *
 * bun isolates each test FILE in its own process, so the module mock here
 * does not leak into sessions.test.ts (which exercises the real resolveLLM).
 *
 *   bun test __tests__/classify-vlm.test.ts
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- control knobs for the mocked vision-inference seam ---------------------
let nextOutput = "";
let nextError: string | undefined;
const inferenceCalls: { task: string; images: any[]; llm: any }[] = [];

mock.module(import.meta.dirname + "/../src/vlm/vision-inference.ts", () => ({
  runVisionInference: async (opts: any) => {
    inferenceCalls.push(opts);
    if (nextError !== undefined) return { output: "", ok: false, error: nextError };
    return { output: nextOutput, ok: true };
  },
}));

// resolveVisionLLM/resolveLLM are de-hardcoded (ticket 01: throw when unconfigured).
// These are I/O tests for the vision-inference seam, not model-resolution tests,
// so stub the resolver to a stable target. Realm-safe (this realm already mocks
// vision-inference; both the code under test and the test's import see this stub).
mock.module(import.meta.dirname + "/../src/sessions.ts", () => ({
  resolveVisionLLM: () => ({ provider: "lm-studio", modelId: "google/gemma-4-12b", thinkingLevel: "off" }),
  resolveLLM: (opts: { provider?: string; model?: string; thinking?: string } = {}) => ({
    provider: opts.provider ?? "lm-studio",
    modelId: opts.model ?? "google/gemma-4-12b",
    thinkingLevel: opts.thinking ?? "off",
  }),
}));

// Import AFTER the mock is registered.
const { classifyProfileViaVlm, parseProfileReply, voteProfile } = await import("../src/vlm/classify-vlm.ts");
const { resolveVisionLLM } = await import("../src/sessions.ts");

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

function reset(overrides: { output?: string; error?: string | null } = {}) {
  nextOutput = overrides.output ?? "";
  nextError = overrides.error ?? undefined;
  inferenceCalls.length = 0;
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

describe("voteProfile (S4)", () => {
  test("single reply -> that profile", () => {
    expect(voteProfile(["paper"])).toBe("paper");
    expect(voteProfile(["diagram"])).toBe("diagram");
  });

  test("clear majority wins (beats specificity)", () => {
    expect(voteProfile(["poster", "paper", "paper"])).toBe("paper");
    expect(voteProfile(["image", "image", "paper"])).toBe("image");
  });

  test("tie broken by specificity (paper > slides > poster > diagram > image)", () => {
    expect(voteProfile(["poster", "paper"])).toBe("paper");
    expect(voteProfile(["image", "slides"])).toBe("slides");
    expect(voteProfile(["image", "diagram"])).toBe("diagram");
  });

  test("empty -> image", () => {
    expect(voteProfile([])).toBe("image");
  });
});

describe("classifyProfileViaVlm — I/O (mocked vision-inference)", () => {
  test("happy path: output is a profile token and parsed", async () => {
    reset({ output: "paper" });
    const r = await classifyProfileViaVlm(imgPath, "image/png");
    expect(r.profile).toBe("paper");
    expect(r.reply).toBe("paper");
  });

  test("noisier reply is still parsed via parseProfileReply", async () => {
    reset({ output: "This looks like slides to me" });
    const r = await classifyProfileViaVlm(imgPath, "image/png");
    expect(r.profile).toBe("slides");
    expect(r.reply).toBe("This looks like slides to me");
  });

  test("garbage reply falls back to image", async () => {
    reset({ output: "not-a-profile" });
    const r = await classifyProfileViaVlm(imgPath, "image/png");
    expect(r.profile).toBe("image");
  });

  test("attaches the image with the given mime type + uses the classifier prompt", async () => {
    reset({ output: "diagram" });
    await classifyProfileViaVlm(imgPath, "image/png");
    expect(inferenceCalls).toHaveLength(1);
    expect(inferenceCalls[0]!.images).toHaveLength(1);
    expect(inferenceCalls[0]!.images[0]!.mimeType).toBe("image/png");
    expect(inferenceCalls[0]!.task.includes("只輸出一個 profile 代碼")).toBe(true);
  });

  test("llmOverride is forwarded verbatim (resolveVisionLLM NOT called)", async () => {
    reset({ output: "poster" });
    const explicit = {
      provider: "anthropic",
      modelId: "claude-x",
      thinkingLevel: "off" as const,
    };
    await classifyProfileViaVlm(imgPath, "image/jpeg", explicit);
    expect(inferenceCalls).toHaveLength(1);
    expect(inferenceCalls[0]!.llm).toBe(explicit);
    expect(inferenceCalls[0]!.llm.provider).toBe("anthropic");
  });

  test("no override → resolveVisionLLM() default target is used", async () => {
    reset({ output: "paper" });
    await classifyProfileViaVlm(imgPath, "image/png");
    expect(inferenceCalls).toHaveLength(1);
    // The source calls runVisionInference with resolveVisionLLM(); assert the
    // captured llm equals the REAL default target (env-robust, no hardcoded model).
    expect(inferenceCalls[0]!.llm).toEqual(resolveVisionLLM());
  });

  test("inference error propagates (classifier does not swallow model errors)", async () => {
    reset({ error: "503 overloaded" });
    await expect(classifyProfileViaVlm(imgPath, "image/png")).rejects.toThrow("503 overloaded");
  });
});
