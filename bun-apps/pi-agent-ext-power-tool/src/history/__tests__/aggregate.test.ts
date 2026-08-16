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

  test("judges a move against the check's OWN historical volatility", () => {
    // History swings 10 → 50 → 20 (moves of 40 and 30), so a final +25 is well
    // inside what this check does when nothing is wrong. A fixed 10pp rule would
    // call it a regression; the adaptive threshold must not.
    const rows = [
      ...sessions(100, "swingy", 10, 0),
      ...sessions(100, "swingy", 50, 1_000_000),
      ...sessions(100, "swingy", 20, 2_000_000),
      ...sessions(100, "swingy", 45, 3_000_000),
    ];
    const v = aggregate(rows, { windowSize: 100, minEvents: 10, deltaPct: 10 }).verdicts.find(
      (x) => x.check === "swingy",
    )!;
    expect(v.deltaPct).toBe(25);
    expect(v.volatilityPct).toBe(40);
    expect(v.thresholdPct).toBe(40);
    expect(v.verdict).toBe("stable");
  });

  test("flags a move that exceeds everything in the check's history", () => {
    const rows = [
      ...sessions(100, "swingy", 10, 0),
      ...sessions(100, "swingy", 50, 1_000_000),
      ...sessions(100, "swingy", 20, 2_000_000),
      ...sessions(100, "swingy", 70, 3_000_000),
    ];
    const v = aggregate(rows, { windowSize: 100, minEvents: 10, deltaPct: 10 }).verdicts.find(
      (x) => x.check === "swingy",
    )!;
    expect(v.deltaPct).toBe(50);
    expect(v.thresholdPct).toBe(40);
    expect(v.verdict).toBe("regressed");
  });

  test("the move being judged never sets its own threshold", () => {
    // Flat history → volatility 0. Without the floor, ANY move would clear a
    // 0pp threshold and every check would read as regressed forever.
    const rows = [
      ...sessions(100, "flat", 10, 0),
      ...sessions(100, "flat", 10, 1_000_000),
      ...sessions(100, "flat", 10, 2_000_000),
      ...sessions(100, "flat", 15, 3_000_000),
    ];
    const v = aggregate(rows, { windowSize: 100, minEvents: 10, deltaPct: 10 }).verdicts.find(
      (x) => x.check === "flat",
    )!;
    expect(v.volatilityPct).toBe(0);
    expect(v.thresholdPct).toBe(10); // the --delta floor won
    expect(v.verdict).toBe("stable");
  });

  test("falls back to the floor when there is no history to measure", () => {
    // Two windows = one move, and that move is the one under judgement.
    const rows = [...sessions(100, "c", 20), ...sessions(100, "c", 60, 1_000_000)];
    const v = aggregate(rows, { windowSize: 100, minEvents: 10, deltaPct: 10 }).verdicts.find(
      (x) => x.check === "c",
    )!;
    expect(v.volatilityPct).toBe(0);
    expect(v.thresholdPct).toBe(10);
    expect(v.verdict).toBe("regressed");
  });

  test("orders sessions by time regardless of input order", () => {
    const rows = [...sessions(5, "c", 0, 1_000_000), ...sessions(5, "c", 5, 0)];
    const out = aggregate(rows, { windowSize: 5, minEvents: 1, deltaPct: 10 });
    expect(out.series.find((x) => x.check === "c")!.points.map((p) => p.ratePct)).toEqual([100, 0]);
  });
});
