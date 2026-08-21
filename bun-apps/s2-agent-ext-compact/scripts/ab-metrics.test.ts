import { describe, expect, test } from "bun:test";
import { computeMetrics, extractErrorStrings, selectSessions, type SessionCandidate } from "./ab-metrics.ts";

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
