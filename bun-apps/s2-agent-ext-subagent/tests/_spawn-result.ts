/**
 * Shared `SpawnSubagentResult` builders for tests.
 *
 * Before the failure union, ~340 lines across this directory were literals of
 * the form `{ output: "x", exitCode: 0, stderr: "", timedOut: false }` — four
 * fields restated per fixture, three of them noise in most tests. That volume is
 * what made the result shape expensive to change, and it is why these builders
 * exist rather than a hand-conversion: the next shape change touches this file.
 *
 * NOT a `.test.ts` on purpose — importing a test file from another test file
 * silently re-runs its suites.
 */

import type { BudgetExhaustion, SpawnSubagentResult, TurnExhaustion } from "@repo/s2-agent-core-runtime";

type Extra = Partial<SpawnSubagentResult>;

/** A successful run. */
export function ok(output = "", extra: Extra = {}): SpawnSubagentResult {
  return { output, ...extra };
}

/** A plain failure (the old `exitCode: 1`). */
export function failed(message = "failed", output = "", extra: Extra = {}): SpawnSubagentResult {
  return { output, failure: { kind: "failed", message }, ...extra };
}

/** A wall-clock timeout or an abort (the old `exitCode: 124, timedOut: true`). */
export function timedout(message = "timed out", output = "", extra: Extra = {}): SpawnSubagentResult {
  return { output, failure: { kind: "timedout", message }, ...extra };
}

/** A token/spend budget abort. */
export function budgetAbort(budget: BudgetExhaustion, output = "", extra: Extra = {}): SpawnSubagentResult {
  const unit = budget.kind === "tokens" ? "tokens" : "spend";
  return {
    output,
    failure: { kind: "budget", message: `subagent ${unit} budget exhausted`, budget },
    ...extra,
  };
}

/** A maxTurns abort. */
export function turnsAbort(turns: TurnExhaustion, output = "", extra: Extra = {}): SpawnSubagentResult {
  return {
    output,
    failure: { kind: "turns", message: `max turns exceeded (${turns.maxTurns})`, turns },
    ...extra,
  };
}
