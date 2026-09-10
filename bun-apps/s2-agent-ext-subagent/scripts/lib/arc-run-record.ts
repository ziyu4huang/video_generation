/**
 * arc-run-record — persist an arc-review dispatch as a STANDARD pi-harness
 * run record so the standing harvest SOP finds it by name (self-arc-22).
 *
 * reviewer-harvest's FALLBACK scans `~/.pi/subagents/runs/<runId>.json` and
 * matches `agentName`; core-runtime already exports the persistence API that
 * writes exactly that shape (`createSubagentRunPersistence` +
 * `generateSubagentRunId`). This helper is the thin bridge: arc-review.ts
 * calls it ONCE per dispatch (success AND failure) right before exiting, and
 * `reviewer-harvest --name arc-reviewer` returns the verdict with zero
 * harvester edits and zero core edits (design ③, self-arc-22 map).
 *
 * Status mapping mirrors the harvester's own vocabulary: no failure →
 * "done" (verdict = the child's output); any SpawnSubagentFailure →
 * "failed" with the kind recorded in `error` (a terminal-without-verdict
 * state for the harvester — PI_TERMINAL_FAILURES).
 */

import {
  type AgentUsage,
  createSubagentRunPersistence,
  generateSubagentRunId,
  type SubagentRunRecord,
  type SubagentRunStatus,
} from "@repo/s2-agent-core-runtime";

export interface ArcReviewRunOutcome {
  /** The harvest name (reviewer-harvest --name). Default "arc-reviewer". */
  name: string;
  /** The review prompt (replay context). */
  task: string;
  /** The requested model spec (double-pinned zai/glm-5.3 in arc-review.ts). */
  model: string;
  cwd: string;
  startedAt: Date;
  elapsedMs: number;
  usage?: AgentUsage;
  /** SpawnSubagentResult.turns when reported. */
  turns?: { turnsUsed: number; maxTurns: number };
  /** SpawnSubagentResult.failure — undefined on success. */
  failure?: { kind: string } | undefined;
  /** The child's answer verbatim (the verdict text). */
  output: string;
}

/** Persist the outcome; returns the run id (also recorded in arc-review's own receipt). */
export function writeArcReviewRunRecord(outcome: ArcReviewRunOutcome, home?: string): string {
  const persistence = createSubagentRunPersistence(home ? { home } : {});
  const id = generateSubagentRunId();
  // D3 empty-output guard (reviewer should-fix, self-arc-22): a "success"
  // with blank output would harvest as still-running FOREVER — the harvester
  // treats `done && output` as completed and `done` is not a terminal
  // failure. A blank verdict is a failed review, not a pending one.
  const blankOutput = !outcome.failure && (!outcome.output || outcome.output.trim().length === 0);
  const status: SubagentRunStatus = outcome.failure || blankOutput ? "failed" : "done";
  const record: SubagentRunRecord = {
    id,
    toolCallId: `arc-review-${id}`,
    agentName: outcome.name,
    task: outcome.task,
    model: outcome.model,
    cwd: outcome.cwd,
    status,
    ...(blankOutput
      ? { error: "empty reviewer output (degenerate success — no verdict text)" }
      : outcome.failure
        ? { error: `${outcome.failure.kind} (arc-review dispatch failure)` }
        : {}),
    startedAt: outcome.startedAt.toISOString(),
    elapsedMs: outcome.elapsedMs,
    ...(outcome.usage ? { usage: outcome.usage } : {}),
    ...(outcome.turns ? { turns: outcome.turns } : {}),
    output: outcome.output,
  };
  persistence.save(record);
  return id;
}
