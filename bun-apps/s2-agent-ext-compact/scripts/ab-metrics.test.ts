import { describe, expect, test } from "bun:test";
import {
  computeMetrics,
  extractErrorStrings,
  FALLBACK_CONTEXT_WINDOW_TOKENS,
  maxPromptTokens,
  partitionByTokenBudget,
  selectSessions,
  type SessionCandidate,
} from "./ab-metrics.ts";

describe("selectSessions", () => {
  test("keeps sessions with ≥ minMessages message entries, largest first, capped at n", () => {
    const c = (id: string, messages: number): SessionCandidate => ({
      id,
      path: `/s/${id}.jsonl`,
      messageEntries: messages,
      bytes: messages * 100,
    });
    const out = selectSessions([c("a", 5), c("b", 500), c("c", 120), c("d", 40)], { minMessages: 50, n: 2 });
    expect(out.map((s) => s.id)).toEqual(["b", "c"]);
  });
});

describe("maxPromptTokens", () => {
  test("half the model's context window; fallback constant without one", () => {
    expect(maxPromptTokens({ contextWindow: 200_000 })).toBe(100_000);
    expect(maxPromptTokens(undefined)).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS / 2);
    expect(maxPromptTokens({ contextWindow: 0 })).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS / 2);
  });
});

describe("partitionByTokenBudget", () => {
  const c = (id: string, estimatedTokens?: number): SessionCandidate => ({
    id,
    path: `/s/${id}.jsonl`,
    messageEntries: 100,
    bytes: 1000,
    estimatedTokens,
  });

  test("drops over-budget sessions with a reason; keeps unknown estimates", () => {
    const { kept, skipped } = partitionByTokenBudget([c("small", 1000), c("huge", 90_000), c("unknown")], 50_000);
    expect(kept.map((s) => s.id)).toEqual(["small", "unknown"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].id).toBe("huge");
    expect(skipped[0].reason).toContain("90000tok");
  });
});

describe("computeMetrics", () => {
  test("compression ratio and delta fields", () => {
    const m = computeMetrics({
      tokensBefore: 10000,
      summaryTokens: 500,
      summarizedEntryTokens: 8000,
      wallMs: 1234,
      usage: { input: 20000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.02 },
    });
    expect(m.compressionRatio).toBeCloseTo(10000 / (10000 - 8000 + 500), 5);
    expect(m.summaryTokens).toBe(500);
    expect(m.cost).toBe(0.02);
  });
});

describe("extractErrorStrings", () => {
  test("pulls Error:/failed lines deterministically, capped", () => {
    const errs = extractErrorStrings("ok\nError: boom x\nit failed badly\nError: second");
    expect(errs).toContain("Error: boom x");
    expect(errs.length).toBeLessThanOrEqual(20);
  });
});
