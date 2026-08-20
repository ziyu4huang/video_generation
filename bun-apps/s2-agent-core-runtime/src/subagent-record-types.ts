/**
 * Record-shape types shared between the subagent dispatch layer and its
 * persistence/run records. These moved here (with subagent-run-persistence.ts)
 * so a portable-base-set extension (obsidian) can import the persistence +
 * subprocess-spawn layer without a dependency on the subagent EXTENSION
 * package — bun-apps/tests/dep-guard.test.ts forbids base-set ext → ext edges.
 *
 * The definition files that used to own them (subagent's git-scope.ts,
 * subagent-tool-schema.ts, watchdog/types.ts) re-export from here, so their
 * public surface is unchanged. Pure data shapes — no behavior.
 */
import type { BudgetWarning } from "./agent-budget.js";

/** Commit-scope check of a completed child run (from subagent's git-scope). */
export interface SubagentScopeCheck {
  /** Commit recorded before dispatch (the base for the child's work). */
  baseCommit: string;
  /**
   * Commit after the child ran, when the repo advanced. Omitted when the child
   * committed nothing (`base === head`) — in which case `touchedPaths` is empty.
   */
  headCommit?: string;
  /** Paths the child committed across `base..HEAD` (best-effort). */
  touchedPaths: string[];
  /** Touched paths NOT covered by `commitScope` (the violation). Empty when in scope. */
  outOfScope: string[];
}

/** Budget block on a run record (from subagent's subagent-tool-schema). */
export interface SubagentBudgetDetails {
  /** Which budget was exceeded (abort path only). */
  kind?: "tokens" | "spend";
  /** The caller-declared ceiling (abort path only). */
  limit?: number;
  /** The cumulative usage at the moment of abort (abort path only). */
  actual?: number;
  /** Informational 80% warning (completed-run path only). */
  warning?: BudgetWarning;
  /**
   * Budget-history cohort (2026-08-18 forward-fix): WHICH mechanism set this
   * dispatch's envelope — the role-aware default (split recon/writer), an
   * explicit caller param, or the tier ceilings. Cohort medians (not raw
   * aggregates) drive recalibration; absent on legacy records = unknown
   * cohort. Coexists with the exhaustion fields above on budget-abort runs.
   */
  source?: "explicit" | "envelope-recon" | "envelope-writer" | "tier";
  /** Cohort envelope's token ceiling, when the tagged mechanism set one. */
  tokenBudget?: number;
  /** Cohort envelope's turn ceiling, when the tagged mechanism set one. */
  maxTurns?: number;
  /** Cohort envelope's wall-clock ceiling (ms), when the tagged mechanism set one. */
  timeoutMs?: number;
}

/**
 * Terminal-abort salvage (2026-08-15 hardening): what an aborted child managed
 * to produce before the ceiling hit. Present only on abort outcomes
 * (budget/turns/timedout/user-abort); old records without it stay valid.
 */
export interface SubagentSalvage {
  /** The child's LAST assistant text, trimmed, capped at 1500 chars. */
  lastText?: string;
  /** Paths touched by write tool calls (edit/write/multiedit/apply_patch),
   *  first-touch order, deduped, capped at 40. */
  files?: string[];
}

/** One watchdog finding (from subagent's watchdog/types). */
export type WatchdogSeverity = "blocker" | "concern" | "watchdog-error";
export type WatchdogSource = "lsp" | "model";

export interface WatchdogFinding {
  severity: WatchdogSeverity;
  source: WatchdogSource;
  path?: string;
  line?: number;
  message: string;
  suggestedFix?: string;
}

export interface WatchdogL1Result {
  ran: boolean;
  provider?: string;
  findings: WatchdogFinding[];
  note?: string;
}

export interface WatchdogL2Result {
  ran: boolean;
  findings: WatchdogFinding[];
  note?: string;
  /** L2 reviewed a partial diff (noise-filtered and/or budget-truncated). */
  truncated?: boolean;
}

export interface WatchdogResult {
  ran: boolean;
  editGated: boolean;
  l1: WatchdogL1Result;
  l2: WatchdogL2Result;
  summary: string;
  elapsedMs: number;
}
