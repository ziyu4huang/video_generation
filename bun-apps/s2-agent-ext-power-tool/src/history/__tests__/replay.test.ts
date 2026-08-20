/**
 * Tests for historical replay.
 *
 * replayScan() is PURE — a SessionScan in, Finding[] out. It must reuse the same
 * argsSig() the live accumulator uses, so a retry loop detected live and the same
 * call sequence replayed from a transcript produce the same finding. The parity
 * test at the bottom is what pins that together.
 */
import { test, expect, describe } from "bun:test";
import { replayScan, resolveContextPercent } from "../replay.ts";
import type { SessionScan } from "../scan.ts";
import {
  getCalls,
  recordCallEnd,
  recordCallStart,
  resetAccumulator,
} from "../../pathology/accumulator.ts";
import { analyzePathology } from "../../pathology/detector.ts";
import type { Finding } from "../../findings.ts";

/** Build a SessionScan with N identical back-to-back bash calls. */
function scanWithRepeats(n: number): SessionScan {
  const calls = Array.from({ length: n }, (_, i) => ({
    callId: `c${i}`,
    name: "bash",
    t0: i * 1000,
    args: { cmd: "git status" },
  }));
  return {
    cwd: "/repo",
    startedAt: 0,
    calls,
    results: calls.map((c) => ({ callId: c.callId, name: "bash", t1: c.t0 + 10, isError: false })),
    maxTotalTokens: 0,
    assistantMessages: 1,
  };
}

describe("replayScan", () => {
  test("detects a retry loop from a replayed transcript", () => {
    const findings = replayScan(scanWithRepeats(4), {});
    expect(findings.some((f) => f.check === "retry-loop")).toBe(true);
  });

  test("does not flag a retry loop below the threshold", () => {
    const findings = replayScan(scanWithRepeats(2), {});
    expect(findings.some((f) => f.check === "retry-loop")).toBe(false);
  });

  test("marks an errored call from its paired result", () => {
    const scan = scanWithRepeats(1);
    scan.results[0]!.isError = true;
    const findings = replayScan(scan, {});
    const stats = findings.find((f) => f.check === "session-stats");
    expect((stats!.detail as { errors: number }).errors).toBe(1);
  });

  test("counts an orphan error result as a call", () => {
    const scan = scanWithRepeats(0);
    scan.results.push({ callId: "__orphan__bash__0", name: "bash", t1: 5, isError: true });
    const findings = replayScan(scan, {});
    const stats = findings.find((f) => f.check === "session-stats");
    expect((stats!.detail as { calls: number }).calls).toBe(1);
  });
});

describe("resolveContextPercent", () => {
  const windows = new Map<string, number>([["glm-5.2", 200_000]]);

  test("computes percent from peak tokens and the model window", () => {
    const scan = { modelId: "glm-5.2", maxTotalTokens: 100_000 } as SessionScan;
    expect(resolveContextPercent(scan, windows)).toBe(50);
  });

  test("returns null — not 0 — when the model window is unknown", () => {
    const scan = { modelId: "gemma-4-26b-a4b-qat", maxTotalTokens: 100_000 } as SessionScan;
    expect(resolveContextPercent(scan, windows)).toBeNull();
  });

  test("returns null when no usage was recorded", () => {
    const scan = { modelId: "glm-5.2", maxTotalTokens: 0 } as SessionScan;
    expect(resolveContextPercent(scan, windows)).toBeNull();
  });
});

describe("live/replay parity", () => {
  test("replaying a transcript reproduces the live accumulator's findings", () => {
    const seq = [
      { id: "c0", name: "bash", args: { cmd: "git status" }, isError: true },
      { id: "c1", name: "bash", args: { cmd: "git status" }, isError: true },
      { id: "c2", name: "bash", args: { cmd: "git status" }, isError: true },
      { id: "c3", name: "read", args: { path: "/a" }, isError: false },
    ];

    // ── live path: feed the accumulator exactly as the SDK hooks do ──
    resetAccumulator();
    for (const s of seq) {
      recordCallStart({ toolCallId: s.id, toolName: s.name, args: s.args });
      recordCallEnd({ toolCallId: s.id, toolName: s.name, result: null, isError: s.isError });
    }
    const live = analyzePathology({ calls: getCalls(), contextPercent: null, turnCount: 1 });
    resetAccumulator();

    // ── replay path: the same sequence as a scanned transcript ──
    const scan: SessionScan = {
      cwd: "/repo",
      startedAt: 0,
      calls: seq.map((s, i) => ({ callId: s.id, name: s.name, t0: i * 10, args: s.args })),
      results: seq.map((s, i) => ({
        callId: s.id,
        name: s.name,
        t1: i * 10 + 1,
        isError: s.isError,
      })),
      maxTotalTokens: 0,
      assistantMessages: 1,
    };
    const replayed = replayScan(scan, {});

    const shape = (fs: Finding[]): string[] =>
      fs
        .filter((f) => f.check !== "session-stats")
        .map((f) => `${f.severity}:${f.check}:${f.message}`)
        .sort();

    expect(shape(replayed)).toEqual(shape(live));
    // and the sequence must actually have tripped something, or this proves nothing
    expect(shape(live).length).toBeGreaterThan(0);
  });
});
