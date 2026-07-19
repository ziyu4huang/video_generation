/**
 * vision_ask tool wrapper — the tool registered by extensions/file2md.ts.
 *
 * The tool is a thin wrapper over askImage() (whose I/O is covered by
 * ask-io.test.ts). Here we mock session-factory.ts and exercise the actual
 * registered tool: param handling, result formatting, error path, relative
 * path resolution.
 *
 *   bun test __tests__/vlm-ask-tool.test.ts
 */
import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// --- mocked session (the model I/O boundary) --------------------------------
let subscriber: ((event: any) => void) | null = null;
let nextDeltas: string[] = ["ok"];
let nextError: Error | null = null;
const sessionOpts: { llm: any; opts: any }[] = [];
const promptCalls: { text: string; imageCount: number }[] = [];

mock.module(import.meta.dirname + "/../src/session-factory.ts", () => ({
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
          promptCalls.push({ text, imageCount: opts?.images?.length ?? 0 });
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

// Load the extension and capture the tools it registers via a fake pi.
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

function reset(o: { deltas?: string[]; error?: Error | null } = {}) {
  nextDeltas = o.deltas ?? ["ok"];
  nextError = o.error ?? null;
  sessionOpts.length = 0;
  promptCalls.length = 0;
  subscriber = null;
}

describe("vision_ask tool", () => {
  test("registers alongside file2md", () => {
    expect(tools.file2md).toBeDefined();
    expect(tools.vision_ask).toBeDefined();
    expect(tools.vision_ask.label).toBe("Vision Image Q&A");
  });

  test("happy path: returns the streamed reply as inline text", async () => {
    reset({ deltas: ["a red ", "car"] });
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
    expect(promptCalls[0]!.text).toBe("count the people");
    expect(promptCalls[0]!.imageCount).toBe(1);
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

  test("forwards systemPrompt to the session", async () => {
    reset();
    await tools.vision_ask.execute(
      "t4",
      { image: pngAbs, question: "q", systemPrompt: "answer in one line" },
      undefined,
      undefined,
      undefined,
    );
    expect(sessionOpts[0]!.opts.appendSystemPrompt).toEqual(["answer in one line"]);
  });

  test("default model resolves via resolveLLM (lm-studio, thinking off)", async () => {
    reset();
    await tools.vision_ask.execute(
      "t5",
      { image: pngAbs, question: "q" },
      undefined,
      undefined,
      undefined,
    );
    expect(sessionOpts[0]!.llm.provider).toBe("lm-studio");
    expect(sessionOpts[0]!.llm.thinkingLevel).toBe("off");
  });

  test("error path: session failure → isError:true with the message", async () => {
    reset({ error: new Error("boom") });
    const res = await tools.vision_ask.execute(
      "t6",
      { image: pngAbs, question: "q" },
      undefined,
      undefined,
      undefined,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/vision_ask failed: boom/);
    expect(res.details.error).toBe("boom");
  });
});
