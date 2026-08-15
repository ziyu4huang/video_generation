/**
 * vision_ask tool wrapper — the tool registered by extensions/file2md.ts.
 *
 * The tool is a thin wrapper over askImage() (whose I/O is covered by
 * ask-io.test.ts). Here we mock vision-inference.ts and exercise the actual
 * registered tool: param handling, result formatting, error path, relative
 * path resolution.
 *
 *   bun test __tests__/vlm-ask-tool.test.ts
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- mocked vision-inference (the model I/O boundary) -----------------------
let nextOutput = "ok";
let nextError: string | null = null;
const inferenceCalls: {
  task: string;
  images: any[];
  llm: any;
  systemPrompt?: string;
}[] = [];

mock.module(import.meta.dirname + "/../src/vlm/vision-inference.ts", () => ({
  runVisionInference: async (opts: any) => {
    inferenceCalls.push(opts);
    if (nextError !== null) return { output: "", ok: false, error: nextError };
    return { output: nextOutput, ok: true };
  },
}));

// resolveVisionLLM/resolveLLM are de-hardcoded (ticket 01: throw when unconfigured).
// This exercises the ask tool's vision-inference wiring, not model resolution —
// stub the resolver to a stable lm-studio target (realm-safe: this realm already
// mocks vision-inference).
mock.module(import.meta.dirname + "/../src/sessions.ts", () => ({
  resolveVisionLLM: () => ({ provider: "lm-studio", modelId: "google/gemma-4-12b", thinkingLevel: "off" }),
  resolveLLM: (opts: { provider?: string; model?: string; thinking?: string } = {}) => ({
    provider: opts.provider ?? "lm-studio",
    modelId: opts.model ?? "google/gemma-4-12b",
    thinkingLevel: opts.thinking ?? "off",
  }),
}));

const tools: Record<string, any> = {};
const fakePi = {
  on: () => {},
  registerTool: (def: any) => {
    tools[def.name] = def;
  },
};
const ext = (await import("../extensions/file2md.ts")).default;
ext(fakePi as any);

let dir: string;
let pngAbs: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pivlm-asktool-"));
  pngAbs = join(dir, "photo.png");
  await writeFile(pngAbs, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function reset(o: { output?: string; error?: string | null } = {}) {
  nextOutput = o.output ?? "ok";
  nextError = o.error ?? null;
  inferenceCalls.length = 0;
}

describe("vision_ask tool", () => {
  test("registers alongside file2md", () => {
    expect(tools.file2md).toBeDefined();
    expect(tools.vision_ask).toBeDefined();
    expect(tools.vision_ask.label).toBe("Vision Image Q&A");
  });

  test("happy path: returns the inference output as inline text", async () => {
    reset({ output: "a red car" });
    const res = await tools.vision_ask.execute(
      "t1",
      { image: pngAbs, question: "what is this?" },
      undefined,
      undefined,
      undefined,
    );
    expect(res.isError).toBeUndefined();
    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text).toBe("a red car");
    expect(res.details.image).toBe(pngAbs);
    expect(res.details.reply).toBe("a red car");
  });

  test("forwards the question verbatim and attaches exactly one image", async () => {
    reset();
    await tools.vision_ask.execute(
      "t2",
      { image: pngAbs, question: "count the people" },
      undefined,
      undefined,
      undefined,
    );
    expect(inferenceCalls[0]!.task).toBe("count the people");
    expect(inferenceCalls[0]!.images).toHaveLength(1);
  });

  test("resolves a relative image path against cwd", async () => {
    reset();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const res = await tools.vision_ask.execute(
        "t3",
        { image: "photo.png", question: "q" },
        undefined,
        undefined,
        undefined,
      );
      // After chdir, process.cwd() is the realpath — match against it (macOS
      // TMPDIR is a /var -> /private/var symlink, so join(dir,...) would differ).
      expect(res.details.image).toBe(join(process.cwd(), "photo.png"));
    } finally {
      process.chdir(cwd);
    }
  });

  test("forwards systemPrompt to runVisionInference", async () => {
    reset();
    await tools.vision_ask.execute(
      "t4",
      { image: pngAbs, question: "q", systemPrompt: "answer in one line" },
      undefined,
      undefined,
      undefined,
    );
    expect(inferenceCalls[0]!.systemPrompt).toBe("answer in one line");
  });

  test("default model resolves via resolveVisionLLM (lm-studio, thinking off)", async () => {
    reset();
    await tools.vision_ask.execute("t5", { image: pngAbs, question: "q" }, undefined, undefined, undefined);
    expect(inferenceCalls[0]!.llm.provider).toBe("lm-studio");
    expect(inferenceCalls[0]!.llm.thinkingLevel).toBe("off");
  });

  test("error path: inference failure → isError:true with the message", async () => {
    reset({ error: "boom" });
    const res = await tools.vision_ask.execute("t6", { image: pngAbs, question: "q" }, undefined, undefined, undefined);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/vision_ask failed: boom/);
    expect(res.details.error).toBe("boom");
  });
});
