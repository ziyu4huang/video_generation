/**
 * askImage I/O — the single-turn "ask a VLM about one image" primitive.
 *
 * The pure helper guessImageMimeType is already covered by src/vlm/ask.test.ts;
 * here we cover the runVisionInference wiring askImage() itself.
 * ../src/vlm/vision-inference.ts is mocked so runVisionInference returns a
 * controllable fake result — no spawnSubagent / LM Studio / network. File
 * isolation keeps this mock out of the other suites.
 *
 *   bun test __tests__/ask-io.test.ts
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
  agentDir?: string;
  modelRuntime?: any;
}[] = [];

mock.module(import.meta.dirname + "/../src/vlm/vision-inference.ts", () => ({
  runVisionInference: async (opts: any) => {
    inferenceCalls.push(opts);
    if (nextError !== undefined) return { output: "", ok: false, error: nextError };
    return { output: nextOutput, ok: true };
  },
}));

// resolveVisionLLM/resolveLLM are de-hardcoded (ticket 01: throw when unconfigured).
// I/O test for the vision-inference seam — stub the resolver to a stable target
// (realm-safe: this realm already mocks vision-inference).
mock.module(import.meta.dirname + "/../src/sessions.ts", () => ({
  resolveVisionLLM: () => ({ provider: "lm-studio", modelId: "google/gemma-4-12b-qat", thinkingLevel: "off" }),
  resolveLLM: (opts: { provider?: string; model?: string; thinking?: string } = {}) => ({
    provider: opts.provider ?? "lm-studio",
    modelId: opts.model ?? "google/gemma-4-12b-qat",
    thinkingLevel: opts.thinking ?? "off",
  }),
}));

const { askImage } = await import("../src/vlm/ask.ts");
const { resolveVisionLLM } = await import("../src/sessions.ts");

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

function reset(overrides: { output?: string; error?: string | null } = {}) {
  nextOutput = overrides.output ?? "";
  nextError = overrides.error ?? undefined;
  inferenceCalls.length = 0;
}

describe("askImage — I/O (mocked vision-inference)", () => {
  test("happy path: runVisionInference output is forwarded verbatim as reply", async () => {
    reset({ output: "a landscape photo." });
    const r = await askImage(pngPath, "describe this");
    expect(r.ok).toBe(true);
    expect(r.reply).toBe("a landscape photo.");
    expect(r.error).toBeUndefined();
  });

  test("passes the question verbatim as the inference task", async () => {
    reset({ output: "x" });
    await askImage(pngPath, "what color is the sky?");
    expect(inferenceCalls[0]!.task).toBe("what color is the sky?");
  });

  test("attaches exactly one image", async () => {
    reset({ output: "x" });
    await askImage(pngPath, "q");
    expect(inferenceCalls[0]!.images).toHaveLength(1);
  });

  test("mime defaults via guessImageMimeType for .jpg", async () => {
    reset({ output: "x" });
    await askImage(jpgPath, "q");
    expect(inferenceCalls[0]!.images[0]!.mimeType).toBe("image/jpeg");
  });

  test("explicit mimeType opt overrides the extension guess", async () => {
    reset({ output: "x" });
    await askImage(pngPath, "q", { mimeType: "image/webp" });
    expect(inferenceCalls[0]!.images[0]!.mimeType).toBe("image/webp");
  });

  test("systemPrompt is forwarded as a string (not wrapped in an array)", async () => {
    reset({ output: "x" });
    await askImage(pngPath, "q", { systemPrompt: "answer in one line" });
    expect(inferenceCalls[0]!.systemPrompt).toBe("answer in one line");
  });

  test("no systemPrompt → undefined (no empty string)", async () => {
    reset({ output: "x" });
    await askImage(pngPath, "q");
    expect(inferenceCalls[0]!.systemPrompt).toBeUndefined();
  });

  test("agentDir is forwarded to runVisionInference", async () => {
    reset({ output: "x" });
    await askImage(pngPath, "q", { agentDir: "/proj/.pi/agent" });
    expect(inferenceCalls[0]!.agentDir).toBe("/proj/.pi/agent");
  });

  test("explicit llm override is used as-is (no resolveVisionLLM defaulting)", async () => {
    reset({ output: "x" });
    const llm = { provider: "zai", modelId: "glm-vlm", thinkingLevel: "off" as const };
    await askImage(pngPath, "q", { llm });
    expect(inferenceCalls[0]!.llm).toBe(llm);
  });

  test("no llm → resolveVisionLLM() default target", async () => {
    reset({ output: "x" });
    await askImage(pngPath, "q");
    expect(inferenceCalls[0]!.llm).toEqual(resolveVisionLLM());
  });

  test("inference error is swallowed into ok:false + error (no throw)", async () => {
    reset({ error: "connection reset" });
    const r = await askImage(pngPath, "q");
    expect(r.ok).toBe(false);
    expect(r.reply).toBe("");
    expect(r.error).toBe("connection reset");
  });

  test("empty output is still ok:true (a valid empty answer)", async () => {
    reset({ output: "" });
    const r = await askImage(pngPath, "q");
    expect(r.ok).toBe(true);
    expect(r.reply).toBe("");
  });
});
