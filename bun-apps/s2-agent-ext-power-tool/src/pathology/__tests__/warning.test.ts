/**
 * Tests for the proactive loop-warning (Phase 1.1).
 *
 * The warner is split into a pure core (pickWorstHighFinding, loopSignature,
 * makeWarner over an injectable surface) so the dedup + set/clear behavior is
 * fully unit-testable without the SDK or any UI.
 */
import { test, expect, describe } from "bun:test";
import { pickWorstHighFinding, loopSignature, makeWarner } from "../warning.ts";
import type { Finding } from "../../findings.ts";
import type { ToolCallRecord } from "../types.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

function rec(toolName: string, argsSig: string, isError = false): ToolCallRecord {
  return { toolName, argsSig, isError, ts: 0 };
}

// ─── pickWorstHighFinding ─────────────────────────────────────────────────────

describe("pickWorstHighFinding", () => {
  test("returns null when there are no high-severity findings", () => {
    const findings: Finding[] = [
      { severity: "medium", check: "error-storm", message: "m", detail: { tool: "bash" } },
      { severity: "info", check: "session-stats", message: "i", detail: {} },
    ];
    expect(pickWorstHighFinding(findings)).toBeNull();
  });

  test("returns the high finding when one is present", () => {
    const findings: Finding[] = [
      { severity: "high", check: "retry-loop", message: "h", detail: { tool: "bash", count: 3 } },
      { severity: "medium", check: "error-storm", message: "m", detail: {} },
    ];
    const worst = pickWorstHighFinding(findings);
    expect(worst?.check).toBe("retry-loop");
  });

  test("among multiple high findings, picks the one with the largest count", () => {
    const findings: Finding[] = [
      { severity: "high", check: "retry-loop", message: "a", detail: { tool: "read", count: 3 } },
      { severity: "high", check: "retry-loop", message: "b", detail: { tool: "bash", count: 5 } },
    ];
    expect((pickWorstHighFinding(findings)?.detail as any).tool).toBe("bash");
  });
});

// ─── loopSignature ────────────────────────────────────────────────────────────

describe("loopSignature", () => {
  test("same check + detail → same signature", () => {
    const a: Finding = { severity: "high", check: "retry-loop", message: "x", detail: { tool: "bash", count: 3 } };
    const b: Finding = { severity: "high", check: "retry-loop", message: "y", detail: { tool: "bash", count: 99 } };
    expect(loopSignature(a)).toBe(loopSignature(b));
  });

  test("different tool → different signature", () => {
    const a: Finding = { severity: "high", check: "retry-loop", message: "x", detail: { tool: "bash", count: 3 } };
    const b: Finding = { severity: "high", check: "retry-loop", message: "y", detail: { tool: "read", count: 3 } };
    expect(loopSignature(a)).not.toBe(loopSignature(b));
  });
});

// ─── makeWarner (dedup + set/clear over an injectable surface) ────────────────

describe("makeWarner", () => {
  test("active retry-loop → sets a status warning naming the tool + count", () => {
    const calls: Record<string, string | undefined> = {};
    const surface = { setStatus: (k: string, t: string | undefined) => { calls[k] = t; } };
    const warn = makeWarner(surface);
    const log = [
      rec("bash", '{"command":"npm test"}'),
      rec("bash", '{"command":"npm test"}'),
      rec("bash", '{"command":"npm test"}'),
    ];
    warn(log);
    expect(calls["pi-pathology"]).toBeTruthy();
    expect(calls["pi-pathology"]).toContain("bash");
  });

  test("dedup: a continuing loop does NOT re-warn for the same signature", () => {
    let setCount = 0;
    const surface = { setStatus: (_k: string, _t: string | undefined) => { setCount++; } };
    const warn = makeWarner(surface);
    const log = [
      rec("bash", '{"command":"npm test"}'),
      rec("bash", '{"command":"npm test"}'),
      rec("bash", '{"command":"npm test"}'),
    ];
    warn(log); // first warn
    log.push(rec("bash", '{"command":"npm test"}')); // 4th identical
    warn(log); // should NOT re-warn (same signature)
    expect(setCount).toBe(1);
  });

  test("no loop → clears the status (sets undefined)", () => {
    const calls: Record<string, string | undefined> = {};
    const surface = { setStatus: (k: string, t: string | undefined) => { calls[k] = t; } };
    const warn = makeWarner(surface);
    warn([rec("read", '{"path":"a"}'), rec("bash", '{"command":"ls"}')]); // varied, no loop
    expect(calls["pi-pathology"]).toBeUndefined();
  });

  test("loop clears then a NEW loop starts → warns again (dedup resets on clear)", () => {
    const setCalls: (string | undefined)[] = [];
    const surface = { setStatus: (_k: string, t: string | undefined) => { setCalls.push(t); } };
    const warn = makeWarner(surface);
    const loop = [
      rec("bash", '{"command":"x"}'),
      rec("bash", '{"command":"x"}'),
      rec("bash", '{"command":"x"}'),
    ];
    warn(loop); // warn
    warn([rec("read", '{"path":"a"})')]); // clear
    warn(loop); // warn again — dedup was cleared
    const warnings = setCalls.filter((t) => typeof t === "string");
    expect(warnings.length).toBe(2);
  });

  test("consecutive-error (high) also triggers a warning", () => {
    const calls: Record<string, string | undefined> = {};
    const surface = { setStatus: (k: string, t: string | undefined) => { calls[k] = t; } };
    const warn = makeWarner(surface);
    warn([
      rec("bash", '{"command":"1"}', true),
      rec("bash", '{"command":"2"}', true),
      rec("bash", '{"command":"3"}', true),
    ]);
    expect(calls["pi-pathology"]).toBeTruthy();
  });
});
