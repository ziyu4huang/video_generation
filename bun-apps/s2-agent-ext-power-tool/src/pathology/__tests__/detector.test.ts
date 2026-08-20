/**
 * Tests for the pathology detector (F v1).
 *
 * The detector is a PURE function over a typed call-log (PathologyInput) — no
 * SDK, no fs, no accumulator. This makes the three v1 detectors
 * (retry-loop, tool error storm, context saturation) fully unit-testable.
 */
import { test, expect, describe } from "bun:test";
import { analyzePathology, argsSig } from "../detector.ts";
import type { PathologyInput, ToolCallRecord } from "../types.ts";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Build a call record. ts defaults to an increasing counter so order is stable. */
let _ts = 0;
function call(
  toolName: string,
  args: unknown,
  opts: { isError?: boolean; ts?: number } = {},
): ToolCallRecord {
  return {
    toolName,
    argsSig: argsSig(args),
    isError: opts.isError ?? false,
    ts: opts.ts ?? _ts++,
  };
}
function resetTs() {
  _ts = 0;
}

function input(
  calls: ToolCallRecord[],
  overrides: Partial<PathologyInput> = {},
): PathologyInput {
  return { calls, contextPercent: null, ...overrides };
}

// ─── argsSig ────────────────────────────────────────────────────────────────

describe("argsSig", () => {
  test("key-order independent (same args, different insertion order → same sig)", () => {
    expect(argsSig({ a: 1, b: 2 })).toBe(argsSig({ b: 2, a: 1 }));
  });

  test("different values → different sig", () => {
    expect(argsSig({ path: "a.ts" })).not.toBe(argsSig({ path: "b.ts" }));
  });

  test("undefined and null are stable", () => {
    expect(argsSig(undefined)).toBe(argsSig(undefined));
    expect(argsSig(null)).toBe(argsSig(null));
    expect(argsSig(undefined)).not.toBe(argsSig(null));
  });

  test("bounded — a huge argument does not produce a multi-KB signature", () => {
    const huge = argsSig({ command: "x".repeat(50_000) });
    expect(huge.length).toBeLessThanOrEqual(256);
  });

  test("nested object keys are sorted too", () => {
    expect(argsSig({ outer: { y: 2, x: 1 } })).toBe(argsSig({ outer: { x: 1, y: 2 } }));
  });
});

// ─── analyzePathology — retry loop ──────────────────────────────────────────

describe("analyzePathology — retry loop", () => {
  test("3 identical (tool+args) within window → high finding", () => {
    resetTs();
    const calls = [
      call("bash", { command: "npm test" }),
      call("bash", { command: "npm test" }),
      call("bash", { command: "npm test" }),
    ];
    const f = analyzePathology(input(calls)).filter((x) => x.check === "retry-loop");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("high");
    expect((f[0].detail as any).tool).toBe("bash");
    expect((f[0].detail as any).count).toBe(3);
  });

  test("2 identical is NOT a loop (below default threshold 3)", () => {
    resetTs();
    const calls = [
      call("bash", { command: "npm test" }),
      call("bash", { command: "npm test" }),
    ];
    expect(analyzePathology(input(calls)).filter((x) => x.check === "retry-loop")).toHaveLength(0);
  });

  test("3 calls to the SAME tool but DIFFERENT args is NOT a loop", () => {
    resetTs();
    const calls = [
      call("bash", { command: "ls" }),
      call("bash", { command: "pwd" }),
      call("bash", { command: "whoami" }),
    ];
    expect(analyzePathology(input(calls)).filter((x) => x.check === "retry-loop")).toHaveLength(0);
  });

  test("respects a custom loopRepeatThreshold", () => {
    resetTs();
    const calls = [
      call("read", { path: "a" }),
      call("read", { path: "a" }),
    ];
    // default threshold 3 → no loop with only 2
    expect(analyzePathology(input(calls)).filter((x) => x.check === "retry-loop")).toHaveLength(0);
    // threshold 2 → now it IS a loop
    expect(
      analyzePathology(input(calls, { loopRepeatThreshold: 2 })).filter((x) => x.check === "retry-loop"),
    ).toHaveLength(1);
  });

  test("only counts identical calls within the rolling window (old repeats age out)", () => {
    resetTs();
    // 2 identical now, then 30 distinct calls, then the 3rd identical — the 3rd
    // is outside the default window together with the first two, so no loop.
    const calls: ToolCallRecord[] = [
      call("bash", { command: "X" }),
      call("bash", { command: "X" }),
    ];
    for (let i = 0; i < 30; i++) calls.push(call("read", { path: `f${i}` }));
    calls.push(call("bash", { command: "X" }));
    // The X's are neither all in-window (the first two are >30 calls back) nor
    // consecutive (separated by 30 reads), so no back-to-back run forms → no
    // loop. Under consecutive-run semantics the isolated trailing X can't start
    // a run regardless of the window.
    expect(analyzePathology(input(calls)).filter((x) => x.check === "retry-loop")).toHaveLength(0);
  });

  test("3 identical but SPREAD OUT (interleaved) is NOT a loop — benign repetition", () => {
    resetTs();
    // The agent runs `git status` 3× interleaved with other work — not a retry
    // loop (no back-to-back identical calls). A count-in-window detector
    // false-positives here (the exact bug behind the permanent "⚠ retry loop:
    // bash ×3" status bar); the consecutive-run detector must not flag it.
    const calls: ToolCallRecord[] = [
      call("bash", { command: "git status" }),
      call("read", { path: "a" }),
      call("bash", { command: "git status" }),
      call("edit", { path: "b" }),
      call("bash", { command: "git status" }),
    ];
    expect(analyzePathology(input(calls)).filter((x) => x.check === "retry-loop")).toHaveLength(0);
  });

  test("3 distinct long-prefix commands (argsSig truncation collision) is NOT a loop", () => {
    resetTs();
    // Each command shares a >MAX_SIG preamble (a shell-function def + long path
    // — a common benign pattern, e.g. defining probe() then running several
    // distinct queries) and differs only in the trailing query. argsSig MUST
    // keep them distinct: head-only truncation would collapse all three to one
    // signature and false-trip the consecutive-run detector (the recurring
    // "⚠ retry loop: bash ×3" status bar). Regression for the truncation bug.
    const PREAMBLE =
      "cd /long/repo/path && probe() { curl -s -X POST http://127.0.0.1:8000/sql " +
      "-H 'surreal-ns: ns' -H 'surreal-db: db' -H 'Accept: application/json' " +
      "-H 'auth: basic' -H 'extra: padding' -H 'more: padding' --data \"$1\"; echo s; ";
    const calls: ToolCallRecord[] = [
      call("bash", { command: PREAMBLE + "echo A; SELECT count() FROM memories;" }),
      call("bash", { command: PREAMBLE + "echo B; SELECT count() FROM tagged;" }),
      call("bash", { command: PREAMBLE + "echo C; SELECT count() FROM memories WHERE x;" }),
    ];
    // The three commands are genuinely distinct → their sigs must differ.
    expect(calls[0]!.argsSig).not.toBe(calls[1]!.argsSig);
    expect(calls[0]!.argsSig).not.toBe(calls[2]!.argsSig);
    // … therefore no false retry-loop finding.
    expect(analyzePathology(input(calls)).filter((x) => x.check === "retry-loop")).toHaveLength(0);
  });
});

// ─── analyzePathology — tool error storm ─────────────────────────────────────

describe("analyzePathology — tool error storm", () => {
  test("error rate ≥ threshold with enough calls → medium", () => {
    resetTs();
    // 6 bash calls, 4 errors → rate 0.667 ≥ 0.5, calls 6 ≥ minCalls 4
    const calls = [
      call("bash", { command: "1" }, { isError: true }),
      call("bash", { command: "2" }, { isError: true }),
      call("bash", { command: "3" }),
      call("bash", { command: "4" }, { isError: true }),
      call("bash", { command: "5" }),
      call("bash", { command: "6" }, { isError: true }),
    ];
    const f = analyzePathology(input(calls)).filter((x) => x.check === "error-storm");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("medium");
    expect((f[0].detail as any).tool).toBe("bash");
    expect((f[0].detail as any).errors).toBe(4);
    expect((f[0].detail as any).calls).toBe(6);
  });

  test("below errorRateMinCalls does not trip the rate check", () => {
    resetTs();
    // 3 calls, 2 errors → rate 0.667 but calls 3 < minCalls 4 → no error-storm
    const calls = [
      call("bash", { command: "1" }, { isError: true }),
      call("bash", { command: "2" }, { isError: true }),
      call("bash", { command: "3" }),
    ];
    expect(analyzePathology(input(calls)).filter((x) => x.check === "error-storm")).toHaveLength(0);
  });

  test("consecutive errors ≥ threshold → high (consecutive-error)", () => {
    resetTs();
    // 3 consecutive errors on the same tool → high; only 3 calls so rate check
    // (minCalls 4) does not also fire.
    const calls = [
      call("bash", { command: "1" }, { isError: true }),
      call("bash", { command: "2" }, { isError: true }),
      call("bash", { command: "3" }, { isError: true }),
    ];
    const f = analyzePathology(input(calls)).filter((x) => x.check === "consecutive-error");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("high");
    expect((f[0].detail as any).tool).toBe("bash");
    expect((f[0].detail as any).consecutive).toBe(3);
  });

  test("errors spread across DIFFERENT tools do not single out one tool", () => {
    resetTs();
    const calls = [
      call("bash", { command: "1" }, { isError: true }),
      call("read", { path: "a" }, { isError: true }),
      call("bash", { command: "2" }, { isError: true }),
      call("read", { path: "b" }, { isError: true }),
    ];
    // each tool: 2 calls, rate 1.0 but calls 2 < minCalls 4 → no error-storm
    expect(analyzePathology(input(calls)).filter((x) => x.check === "error-storm")).toHaveLength(0);
  });
});

// ─── analyzePathology — context saturation ───────────────────────────────────

describe("analyzePathology — context saturation", () => {
  test("contextPercent ≥ threshold → medium hint", () => {
    resetTs();
    const f = analyzePathology(input([], { contextPercent: 90 })).filter(
      (x) => x.check === "context-saturation",
    );
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("medium");
    expect((f[0].detail as any).percent).toBe(90);
  });

  test("contextPercent null → no saturation finding", () => {
    resetTs();
    expect(
      analyzePathology(input([], { contextPercent: null })).filter(
        (x) => x.check === "context-saturation",
      ),
    ).toHaveLength(0);
  });

  test("respects custom saturationPercent", () => {
    resetTs();
    // 50% with default threshold 85 → no finding
    expect(
      analyzePathology(input([], { contextPercent: 50 })).filter(
        (x) => x.check === "context-saturation",
      ),
    ).toHaveLength(0);
    // threshold 40 → now it trips
    expect(
      analyzePathology(input([], { contextPercent: 50, saturationPercent: 40 })).filter(
        (x) => x.check === "context-saturation",
      ),
    ).toHaveLength(1);
  });
});

// ─── clean / integration ─────────────────────────────────────────────────────

describe("analyzePathology — clean session", () => {
  test("varied successful calls + low context → no actionable findings", () => {
    resetTs();
    const calls = [
      call("read", { path: "a" }),
      call("bash", { command: "ls" }),
      call("edit", { path: "b" }),
      call("read", { path: "c" }),
    ];
    const f = analyzePathology(input(calls, { contextPercent: 30 }));
    // only info-level "session-stats" (if any) allowed; no high/medium/low
    const actionable = f.filter((x) => x.severity !== "info");
    expect(actionable).toHaveLength(0);
  });
});

// ─── analyzePathology — long-session recall risk (v2, deterministic) ────────────

describe("analyzePathology — long-session recall risk", () => {
  test("turnCount at/above threshold → medium hint", () => {
    resetTs();
    const f = analyzePathology(input([], { contextPercent: 30, turnCount: 20 })).filter(
      (x) => x.check === "long-session-recall-risk",
    );
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("medium");
    expect((f[0].detail as any).turnCount).toBe(20);
  });

  test("turnCount below threshold → no finding", () => {
    resetTs();
    expect(
      analyzePathology(input([], { contextPercent: 30, turnCount: 5 })).filter(
        (x) => x.check === "long-session-recall-risk",
      ),
    ).toHaveLength(0);
  });

  test("turnCount null (no turn tracking / print mode) → no finding", () => {
    resetTs();
    expect(
      analyzePathology(input([], { contextPercent: 30, turnCount: null })).filter(
        (x) => x.check === "long-session-recall-risk",
      ),
    ).toHaveLength(0);
  });

  test("respects a custom longSessionTurnThreshold", () => {
    resetTs();
    // turnCount 10 with default threshold 15 → no finding
    expect(
      analyzePathology(input([], { contextPercent: 30, turnCount: 10 })).filter(
        (x) => x.check === "long-session-recall-risk",
      ),
    ).toHaveLength(0);
    // threshold 8 → now it trips
    expect(
      analyzePathology(input([], { contextPercent: 30, turnCount: 10, longSessionTurnThreshold: 8 })).filter(
        (x) => x.check === "long-session-recall-risk",
      ),
    ).toHaveLength(1);
  });
});
