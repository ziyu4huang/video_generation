import { describe, expect, test } from "bun:test";
import { summarizeCcStyle } from "./summarize.ts";

const model = {
  provider: "zai",
  id: "glm-5.3",
  maxTokens: 100000,
} as never;

const messages = [
  { role: "user" as const, content: [{ type: "text" as const, text: "fix the failing test" }] },
] as never;

type FakeResponse = {
  stopReason: string;
  usage: object;
  content: Array<{ type: "text"; text: string }>;
};

const fakeComplete = (over: Partial<{ stopReason: string; text: string; usage: object }> = {}) =>
  // Cast through unknown (not never) so the spy body can call the result under strict tsc.
  (async () => ({
    stopReason: over.stopReason ?? "stop",
    usage: over.usage ?? { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0 },
    content: [{ type: "text" as const, text: over.text ?? "<analysis>a</analysis><summary>done</summary>" }],
  })) as unknown as () => Promise<FakeResponse>;

describe("summarizeCcStyle", () => {
  test("happy path: returns extracted summary + usage + sessionType", async () => {
    const r = await summarizeCcStyle(
      { messages, previousSummary: undefined, customInstructions: "auth focus", reserveTokens: 16000, signal: new AbortController().signal },
      model,
      { apiKey: "k" },
      { complete: fakeComplete() as never },
    );
    expect(r.summary).toBe("done");
    expect(r.sessionType).toBe("discussion"); // no tool calls in fixture
    expect(r.usage?.input).toBe(10);
  });
  test("throws on stopReason error (hook will catch → built-in fallback)", async () => {
    await expect(
      summarizeCcStyle(
        { messages, reserveTokens: 16000, signal: new AbortController().signal },
        model,
        { apiKey: "k" },
        { complete: fakeComplete({ stopReason: "error" }) as never },
      ),
    ).rejects.toThrow(/Summarization failed/);
  });
  test("maxTokens = min(floor(factor × reserveTokens), model.maxTokens)", async () => {
    let seen: Record<string, unknown> = {};
    const spy = (async (_m: unknown, _c: unknown, opts: unknown) => {
      seen = opts as Record<string, unknown>;
      return fakeComplete()();
    }) as never;
    // floor(0.5 × 1000) = 500, but model.maxTokens = 100 caps it → 100.
    await summarizeCcStyle(
      { messages, reserveTokens: 1000, signal: new AbortController().signal },
      { ...(model as object), maxTokens: 100 } as never,
      { apiKey: "k" },
      { maxTokensFactor: 0.5, complete: spy },
    );
    expect(seen.maxTokens).toBe(100);
    // Without the model cap, the factor × reserveTokens floor wins → 500.
    await summarizeCcStyle(
      { messages, reserveTokens: 1000, signal: new AbortController().signal },
      model,
      { apiKey: "k" },
      { maxTokensFactor: 0.5, complete: spy },
    );
    expect(seen.maxTokens).toBe(500);
  });
});
