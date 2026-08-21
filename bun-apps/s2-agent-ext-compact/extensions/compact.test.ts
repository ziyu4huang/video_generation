import { describe, expect, test } from "bun:test";
import { createCompactExtension } from "./compact.ts";

const prep = {
  firstKeptEntryId: "entry-42",
  messagesToSummarize: [],
  turnPrefixMessages: [],
  isSplitTurn: false,
  tokensBefore: 9000,
  previousSummary: undefined,
  fileOps: { read: new Set(), written: new Set(), edited: new Set() },
  settings: { enabled: true, reserveTokens: 16000, keepRecentTokens: 4000 },
};

const event = (over: Record<string, unknown> = {}) =>
  ({ type: "session_before_compact", preparation: prep, branchEntries: [], reason: "manual", willRetry: false, signal: new AbortController().signal, ...over }) as never;

const ctx = (over: Record<string, unknown> = {}) =>
  ({
    cwd: "/tmp",
    model: { provider: "zai", id: "glm-5.3", maxTokens: 100000 },
    modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) },
    ui: { notify: () => {} },
    ...over,
  }) as never;

function run(factory: ReturnType<typeof createCompactExtension>) {
  const handlers: Array<(e: never, c: never) => Promise<unknown>> = [];
  factory({ on: (name: string, h: never) => { if (name === "session_before_compact") handlers.push(h); } } as never);
  return handlers;
}

describe("compact extension hook", () => {
  test("returns compaction reusing host cut point + tokensBefore", async () => {
    const summarize = (async () => ({
      summary: "S", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
      sessionType: "implementation", fileOps: { read: [], written: [], edited: [] }, userMessages: [],
    })) as never;
    const [h] = run(createCompactExtension({ summarize, config: { enabled: true, modelOverrideSpec: undefined, maxTokensFactor: 0.8 } }));
    const result = (await h(event(), ctx())) as { compaction: Record<string, unknown> };
    expect(result.compaction.firstKeptEntryId).toBe("entry-42");
    expect(result.compaction.tokensBefore).toBe(9000);
    expect(result.compaction.summary).toBe("S");
    expect((result.compaction.details as { engine: string }).engine).toBe("cc-style");
  });

  test("summarize throws → returns undefined and notifies (built-in fallback)", async () => {
    const summarize = (async () => { throw new Error("LLM unreachable"); }) as never;
    const notifications: string[] = [];
    const [h] = run(createCompactExtension({ summarize, config: { enabled: true, modelOverrideSpec: undefined, maxTokensFactor: 0.8 } }));
    const result = await h(event(), ctx({ ui: { notify: (m: string) => notifications.push(m) } }));
    expect(result).toBeUndefined();
    expect(notifications[0]).toContain("falling back");
  });

  test("disabled config → no handler registered", () => {
    const handlers = run(createCompactExtension({ config: { enabled: false, modelOverrideSpec: undefined, maxTokensFactor: 0.8 } }));
    expect(handlers.length).toBe(0);
  });

  test("no auth → undefined fallback + notify", async () => {
    const summarize = (async () => ({ summary: "S" })) as never;
    const [h] = run(createCompactExtension({ summarize, config: { enabled: true, modelOverrideSpec: undefined, maxTokensFactor: 0.8 } }));
    const result = await h(event(), ctx({ modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }) } }));
    expect(result).toBeUndefined();
  });
});
