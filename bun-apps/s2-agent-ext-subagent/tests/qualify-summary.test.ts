/**
 * Unit gates for the qualify sweep aggregation — NO spawns, no LLM (ticket
 * t01 step 3): fixture receipts (green / red / missing) through the summary
 * and exit-code logic, mirroring the bench-base-tech test precedent.
 */
import { describe, expect, test } from "bun:test";
import { ALL_SCENARIOS, buildSummary, isRed, type ScenarioOutcome } from "../scripts/lib/qualify/summary.js";

function outcome(partial: Partial<ScenarioOutcome>): ScenarioOutcome {
  return {
    scenario: "dispatch",
    receiptPass: null,
    exitCode: null,
    wallMs: 0,
    receiptPath: "/x/receipt.json",
    ...partial,
  };
}

describe("qualify summary aggregation", () => {
  test("green receipt + exit 0 is not red", () => {
    expect(isRed(outcome({ receiptPass: true, exitCode: 0 }))).toBe(false);
  });

  test("receipt fail is red", () => {
    expect(isRed(outcome({ receiptPass: false, exitCode: 0 }))).toBe(true);
  });

  test("missing/unreadable receipt is RED — never silently skipped", () => {
    expect(isRed(outcome({ receiptPass: null, exitCode: 0 }))).toBe(true);
    expect(isRed(outcome({ receiptPass: null, exitCode: null }))).toBe(true);
  });

  test("nonzero child exit is red even if the receipt says pass", () => {
    expect(isRed(outcome({ receiptPass: true, exitCode: 1 }))).toBe(true);
  });

  test("summary table: mixed outcomes render verdicts, walls, rpc cells", () => {
    const s = buildSummary([
      outcome({ scenario: "dispatch", receiptPass: true, exitCode: 0, wallMs: 61_000 }),
      outcome({ scenario: "viewer", receiptPass: false, exitCode: 1, wallMs: 40_000 }),
      outcome({ scenario: "agents", receiptPass: null, exitCode: null, wallMs: 0 }),
      outcome({ scenario: "workflow", receiptPass: true, exitCode: 0, rpcCrossCheck: "model-ok+settled (12s boot)" }),
    ]);
    expect(s.allGreen).toBe(false);
    expect(s.redCount).toBe(2);
    expect(s.md).toContain("| dispatch | ✅ | 61.0s | — |");
    expect(s.md).toContain("| viewer | ❌ RED | 40.0s | — |");
    expect(s.md).toContain("| agents | ❌ RED | — | — |");
    expect(s.md).toContain("model-ok+settled");
    const parsed = JSON.parse(s.json) as { allGreen: boolean; rows: Array<{ scenario: string; pass: boolean }> };
    expect(parsed.allGreen).toBe(false);
    expect(parsed.rows.find((r) => r.scenario === "dispatch")?.pass).toBe(true);
    expect(parsed.rows.find((r) => r.scenario === "agents")?.pass).toBe(false);
  });

  test("all-green sweep yields allGreen + exit-0 shape", () => {
    const s = buildSummary(
      ALL_SCENARIOS.map((sc) => outcome({ scenario: sc, receiptPass: true, exitCode: 0, wallMs: 1000 })),
    );
    expect(s.allGreen).toBe(true);
    expect(s.redCount).toBe(0);
    expect(s.md).toContain("green: 10 · red: 0");
  });
});
