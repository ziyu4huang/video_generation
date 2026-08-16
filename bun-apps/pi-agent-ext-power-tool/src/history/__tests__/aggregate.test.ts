/**
 * Tests for longitudinal aggregation.
 *
 * The load-bearing rule is the minEvents guard: measured base rates make
 * retry-loop (0.9%) and error-storm (1.8%) far too sparse for a windowed verdict,
 * so those must report insufficient-signal rather than a confident direction.
 */
import { test, expect, describe } from "bun:test";
import { aggregate, type SessionResult } from "../aggregate.ts";

/** N sessions, the first `hits` of which fired `check`. */
function sessions(n: number, check: string, hits: number, startTs = 0): SessionResult[] {
  return Array.from({ length: n }, (_, i) => ({
    startedAt: startTs + i * 1000,
    checks: i < hits ? [check] : [],
  }));
}

describe("aggregate", () => {
  test("computes occurrence rate per bucket", () => {
    const out = aggregate(sessions(10, "retry-loop", 3), {
      windowSize: 5,
      minEvents: 1,
      deltaPct: 10,
    });
    const s = out.series.find((x) => x.check === "retry-loop")!;
    expect(s.points.map((p) => p.ratePct)).toEqual([60, 0]);
  });

  test("reports insufficient-signal when the baseline is too sparse", () => {
    // 2 events in the baseline window, minEvents 10 → no verdict.
    const rows = [...sessions(100, "retry-loop", 2), ...sessions(100, "retry-loop", 40, 1_000_000)];
    const out = aggregate(rows, { windowSize: 100, minEvents: 10, deltaPct: 10 });
    const v = out.verdicts.find((x) => x.check === "retry-loop")!;
    expect(v.verdict).toBe("insufficient-signal");
  });

  test("flags a regression when the rate climbs past the delta", () => {
    const rows = [...sessions(100, "consec", 20), ...sessions(100, "consec", 60, 1_000_000)];
    const out = aggregate(rows, { windowSize: 100, minEvents: 10, deltaPct: 10 });
    const v = out.verdicts.find((x) => x.check === "consec")!;
    expect(v.verdict).toBe("regressed");
    expect(v.deltaPct).toBe(40);
  });

  test("flags an improvement when the rate falls past the delta", () => {
    const rows = [...sessions(100, "consec", 60), ...sessions(100, "consec", 20, 1_000_000)];
    const out = aggregate(rows, { windowSize: 100, minEvents: 10, deltaPct: 10 });
    expect(out.verdicts.find((x) => x.check === "consec")!.verdict).toBe("improved");
  });

  test("calls a small move stable", () => {
    const rows = [...sessions(100, "consec", 20), ...sessions(100, "consec", 25, 1_000_000)];
    const out = aggregate(rows, { windowSize: 100, minEvents: 10, deltaPct: 10 });
    expect(out.verdicts.find((x) => x.check === "consec")!.verdict).toBe("stable");
  });

  test("emits no verdict when there is only one window of history", () => {
    const out = aggregate(sessions(50, "consec", 25), {
      windowSize: 100,
      minEvents: 10,
      deltaPct: 10,
    });
    expect(out.verdicts).toHaveLength(0);
  });

  test("orders sessions by time regardless of input order", () => {
    const rows = [...sessions(5, "c", 0, 1_000_000), ...sessions(5, "c", 5, 0)];
    const out = aggregate(rows, { windowSize: 5, minEvents: 1, deltaPct: 10 });
    expect(out.series.find((x) => x.check === "c")!.points.map((p) => p.ratePct)).toEqual([100, 0]);
  });
});
