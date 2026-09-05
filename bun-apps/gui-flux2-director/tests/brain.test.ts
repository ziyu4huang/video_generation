import { describe, expect, test } from "bun:test";

import {
  buildStoryPrompt,
  coerceStoryboard,
  extractJsonObject,
  resolveBrainModel,
  writeStoryboard,
} from "../lib/brain";

describe("extractJsonObject", () => {
  test("strips markdown fences and surrounding prose", () => {
    const raw = 'Here you go:\n```json\n{"title": "T", "scenes": []}\n```\nHope that helps!';
    expect(extractJsonObject(raw)).toEqual({ title: "T", scenes: [] });
  });

  test("rejects when no object is present", () => {
    expect(() => extractJsonObject("no json here")).toThrow(/no JSON object/);
  });
});

describe("coerceStoryboard", () => {
  test("trims to the requested scene count", () => {
    const raw = {
      title: "T",
      scenes: Array.from({ length: 5 }, (_, i) => ({ visual: `v${i}`, narration: `n${i}` })),
    };
    const out = coerceStoryboard(raw, 3);
    expect(out.scenes.length).toBe(3);
    expect(out.title).toBe("T");
  });

  test("unwraps quoted narration and drops empty visuals", () => {
    const out = coerceStoryboard(
      { scenes: [{ visual: "a cat", narration: "“it watches”" }, { visual: "  ", narration: "x" }] },
      2,
    );
    expect(out.scenes).toEqual([{ visual: "a cat", narration: "it watches" }]);
  });

  test("defaults the title when missing", () => {
    const out = coerceStoryboard({ scenes: [{ visual: "v" }] }, 1);
    expect(out.title).toBe("Untitled");
  });

  test("rejects an empty scenes array", () => {
    expect(() => coerceStoryboard({ scenes: [] }, 2)).toThrow(/no scenes/);
  });
});

describe("buildStoryPrompt", () => {
  test("carries the idea, count, and narration budget", () => {
    const p = buildStoryPrompt("a cat", 4, 4);
    expect(p).toContain('"a cat"');
    expect(p).toContain("4-scene");
    expect(p).toContain("max 10 words"); // 4s * 2.5 wps
  });
});

/** Canned fetch: models endpoint + a chat completion echoing `reply`. */
function cannedFetch(reply: string, opts: { loaded?: string[] } = {}): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/api/v1/models")) {
      return Response.json({ models: (opts.loaded ?? ["prism-ml/bonsai-27b"]).map((key) => ({ type: "llm", key, loaded_instances: [{}] })) });
    }
    if (url.endsWith("/models/load")) return new Response("{}");
    if (url.endsWith("/chat/completions")) {
      const body = JSON.parse(init?.body as string);
      expect(body.messages.length).toBe(2); // system + user
      return Response.json({ choices: [{ message: { content: reply } }] });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("writeStoryboard", () => {
  const board = { title: "T", scenes: [{ visual: "a cat by the sea", narration: "salt in the air" }] };

  test("happy path: parse, coerce, report the model", async () => {
    const out = await writeStoryboard("a cat", 1, 2, { _fetchImpl: cannedFetch(JSON.stringify(board)) });
    expect(out.title).toBe("T");
    expect(out.scenes[0]!.visual).toBe("a cat by the sea");
    expect(out.model).toBe("prism-ml/bonsai-27b");
  });

  test("retries once when the first reply is unparseable", async () => {
    let calls = 0;
    const fetchImpl = (async (input: any, init?: any) => {
      if (String(input).endsWith("/chat/completions")) {
        calls += 1;
        return Response.json({ choices: [{ message: { content: calls === 1 ? "I cannot do JSON, sorry!" : JSON.stringify(board) } }] });
      }
      return cannedFetch("")(input, init);
    }) as unknown as typeof fetch;
    const out = await writeStoryboard("a cat", 1, 2, { _fetchImpl: fetchImpl });
    expect(out.title).toBe("T");
    expect(calls).toBe(2);
  });

  test("unreachable server surfaces an actionable error", async () => {
    const dead = (async () => {
      throw new Error("Connection refused");
    }) as unknown as typeof fetch;
    await expect(writeStoryboard("a cat", 1, 2, { _fetchImpl: dead })).rejects.toThrow(/start LM Studio/);
  });

  test("retries when the first reply omits narration, then soft-lands visuals-only", async () => {
    let calls = 0;
    const silent = JSON.stringify({ title: "T", scenes: [{ visual: "a cat" }] });
    const fetchImpl = (async (input: any, init?: any) => {
      if (String(input).endsWith("/chat/completions")) {
        calls += 1;
        return Response.json({ choices: [{ message: { content: silent } }] });
      }
      return cannedFetch("")(input, init);
    }) as unknown as typeof fetch;
    const out = await writeStoryboard("a cat", 1, 2, { _fetchImpl: fetchImpl });
    expect(calls).toBe(2); // retried for the missing narration…
    expect(out.scenes[0]!.narration).toBe(""); // …then delivered visuals-only
  });

  test("retries a short scene count, then soft-lands with fewer scenes", async () => {
    let calls = 0;
    const one = JSON.stringify({ title: "T", scenes: [{ visual: "a cat", narration: "it waits" }] });
    const fetchImpl = (async (input: any, init?: any) => {
      if (String(input).endsWith("/chat/completions")) {
        calls += 1;
        return Response.json({ choices: [{ message: { content: one } }] });
      }
      return cannedFetch("")(input, init);
    }) as unknown as typeof fetch;
    const out = await writeStoryboard("a cat", 2, 2, { _fetchImpl: fetchImpl });
    expect(calls).toBe(2); // asked again for the missing 2nd scene…
    expect(out.scenes.length).toBe(1); // …then delivered the 1-scene story
  });
});

describe("resolveBrainModel", () => {
  test("prefers a loaded bonsai, else any loaded llm", async () => {
    const f = cannedFetch("", { loaded: ["qwen/x", "prism-ml/bonsai-27b"] });
    expect(await resolveBrainModel("http://localhost:1234/v1", f)).toBe("prism-ml/bonsai-27b");
    const f2 = cannedFetch("", { loaded: ["qwen/x"] });
    expect(await resolveBrainModel("http://localhost:1234/v1", f2)).toBe("qwen/x");
  });

  test("falls back to the preferred key when nothing is loaded", async () => {
    const none = (async (_i: any) => Response.json({ models: [] })) as unknown as typeof fetch;
    expect(await resolveBrainModel("http://localhost:1234/v1", none)).toBe("prism-ml/bonsai-27b");
  });
});
