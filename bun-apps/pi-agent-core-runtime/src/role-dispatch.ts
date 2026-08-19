/**
 * role-dispatch — the direct-call dispatch seam: role-aware budget envelope +
 * the abort-safety prompt footer that travels with it.
 *
 * MOVED here from pi-agent-ext-subagent/src/subagent-tool-run.ts. It sat in the
 * subagent EXTENSION while four other extensions (hermes-memory's four
 * background handlers, file2md's vision inference) called it directly — an
 * ext→ext runtime edge that was papered over by promoting the whole subagent
 * package to an sh-deploy HOST MODULE. Dispatch policy is runtime vocabulary,
 * not extension surface: it belongs beside {@link spawnSubagent} (this
 * package) so callers depend on the runtime and the subagent extension stays
 * removable. See tests/extension-isolation-contract.test.ts invariant (1).
 *
 * subagent-tool-run.ts re-exports every symbol here, so the tool seam's own
 * call sites are unchanged.
 */
import { roleAwareDefaults } from "./budget-defaults.js";
import { appendEnvHints } from "./env-hints.js";

// ---- abort-safety prompt footer (2026-08-15 hardening H4) ----

const WRITE_TOOL_NAMES = new Set(["edit", "write", "multiedit", "apply_patch", "bash"]);

/**
 * Whether the child's effective toolset can mutate the repo (a write tool not
 * denied by excludeTools). An UNRESTRICTED child (no allowlist) reads as true
 * — bash/edit are available in that case.
 */
export function hasWriteTools(tools: string[] | undefined, excludeTools?: string[]): boolean {
  if (!tools) return true;
  const denied = new Set(excludeTools ?? []);
  return tools.some((t) => WRITE_TOOL_NAMES.has(t) && !denied.has(t));
}

/**
 * Footer gate: write-capable child OR a long (maxTurns>10) run.
 *
 * 2026-08-18: the recon role envelope (12 turns) intentionally crosses this
 * gate — read-only recon children must log progress as-you-go per the dispatch
 * empirics (turns-limit deaths are the top killer; last words are not evidence).
 */
export function shouldInjectFooter(ctx: { tools?: string[]; excludeTools?: string[]; maxTurns?: number }): boolean {
  return hasWriteTools(ctx.tools, ctx.excludeTools) || (ctx.maxTurns ?? 0) > 10;
}

/** Run-scoped progress-log path cited by the abort-safety footer. */
export function abortSafetyLogPath(toolCallId: string): string {
  return `/tmp/subagent-runs/${toolCallId}.md`;
}

/**
 * ≤6-line footer appended to the SPAWNED task (never the persisted
 * params.task) for write-capable or long dispatches. Mandates the three
 * behaviors that make an aborted child recoverable: a run-scoped progress log
 * written as-you-go, shell-level timeouts + orphan cleanup, and
 * report-to-log BEFORE replying at the limits.
 */
export function abortSafetyFooter(logPath: string): string {
  return [
    "",
    "--- abort-safety (appended by the dispatch layer — obey; don't restate) ---",
    `- Append progress/findings to ${logPath} as you go (create the file and its dir if missing).`,
    "- Wrap long shell commands in `timeout <seconds> <cmd>`; kill orphan processes you spawn.",
    "- Near your turn/budget limits, FIRST write your final report to that log file, then reply.",
  ].join("\n");
}

/**
 * Which mechanism set a dispatch's budget envelope, plus the ceilings it
 * chose. Cohort medians (not raw aggregates) drive recalibration; an absent
 * cohort on a legacy record means "unknown", not "none".
 *
 * The subagent tool's `SubagentBudgetDetails` EXTENDS this with its
 * abort-path exhaustion fields — the cohort vocabulary is declared once, here,
 * because both the tool seam and this direct-call seam emit it.
 */
export interface DispatchBudgetCohort {
  /** WHICH mechanism set the envelope. */
  source?: "explicit" | "envelope-recon" | "envelope-writer" | "tier";
  /** Cohort envelope's token ceiling, when the tagged mechanism set one. */
  tokenBudget?: number;
  /** Cohort envelope's turn ceiling, when the tagged mechanism set one. */
  maxTurns?: number;
  /** Cohort envelope's wall-clock ceiling (ms), when the tagged mechanism set one. */
  timeoutMs?: number;
}

/** 2026-08-18 recovery parity: direct spawnSubagent callers bypassed the tool
 * layer's abort-safety footer — their children died at the new role caps with
 * no as-you-go log, defeating janitor recovery (dispatch empirics: last words
 * are not evidence; the log file is). Caps and footer travel together: applied
 * envelope ⇒ footer appended; disabled (SUBAGENT_TOKEN_BUDGET_DISABLE) ⇒ neither.
 * The envelope wall is included; a caller wanting a tighter wall sets its own
 * timeoutMs after the spread (object-literal later keys win). */
export function roleAwareDirectCall(
  role: "recon" | "writer",
  task: string,
  logId: string,
): {
  task: string;
  tokenBudget?: number;
  maxTurns?: number;
  timeoutMs?: number;
  budgetCohort?: DispatchBudgetCohort;
} {
  const d = roleAwareDefaults({}, role);
  // Hints are independent of the budget envelope: present file ⇒ appended in
  // BOTH branches (applied + not-applied), always BEFORE abort-safety.
  if (!d.applied) return { task: appendEnvHints(task) };
  const withHints = appendEnvHints(task);
  const wrapped = shouldInjectFooter({ maxTurns: d.maxTurns })
    ? `${withHints}${abortSafetyFooter(abortSafetyLogPath(logId))}`
    : withHints;
  // Cohort tag mirrors the tool-seam derivation: direct calls omit all three
  // bounds by construction, so the cohort is always "envelope-<role>".
  return {
    task: wrapped,
    tokenBudget: d.tokenBudget,
    maxTurns: d.maxTurns,
    timeoutMs: d.timeoutMs,
    budgetCohort: {
      source: `envelope-${role}` as const,
      tokenBudget: d.tokenBudget,
      maxTurns: d.maxTurns,
      timeoutMs: d.timeoutMs,
    },
  };
}
