/**
 * TS ports of the upstream planning-with-files helper scripts.
 *
 * De-Pythonization target (Phase 3 of the conversion): the upstream
 * `session-catchup.py` parses Claude Code / Codex / OpenCode session JSONL in
 * `~/.claude`, `~/.codex`, or the OpenCode SQLite DB. None of those exist in a
 * Pi session — Pi keeps its own session store. The faithful Pi-native
 * equivalent of "what changed since the planning files were last updated?" is a
 * `git diff --stat` summary, which is dependency-free (git is already a Pi
 * prerequisite) and IDE-agnostic. `check-complete.sh`'s advisory report is
 * reproduced from the in-process plan parser — no shell, no grep.
 *
 * Pure TS: no `python3`, no `uv`, no `.sh`, no `.ps1` is invoked at runtime.
 */

import { spawnSync } from "node:child_process";
import { PKG_NAME } from "./constants.js";
import { isAllPhasesComplete, type PlanStatus, readPlanStatus, summarizePlan } from "./plan.js";

export interface CatchupResult {
  /** Whether a catchup notice is worth surfacing. */
  relevant: boolean;
  /** A short status string suitable for ui.setStatus. */
  summary: string;
  /** The raw `git diff --stat` output (empty if git unavailable / no changes). */
  diffStat: string;
}

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Best-effort `git diff --stat` against the working tree. Used by session_start
 * to surface "code changed since the plan was last updated" without depending
 * on any IDE-specific session log. Never throws; a missing git or non-repo cwd
 * simply yields an empty result.
 */
export function runSessionCatchup(cwd: string): CatchupResult {
  const status = readPlanStatus(cwd);
  if (!status.exists) {
    return { relevant: false, summary: `${PKG_NAME}: no active plan`, diffStat: "" };
  }

  const diffStat = gitDiffStat(cwd);
  const tail = diffStat.trim();
  if (!tail) {
    return {
      relevant: true,
      summary: `${PKG_NAME}: ${summarizePlan(status)} — run /plan execute to activate hooks`,
      diffStat: "",
    };
  }

  const changedFiles = tail.split("\n").filter((line) => line.trim().length > 0).length;
  return {
    relevant: true,
    summary: `${PKG_NAME}: ${summarizePlan(status)} — ${changedFiles} changed path(s) since last sync`,
    diffStat: tail,
  };
}

function gitDiffStat(cwd: string): string {
  // `--no-color` + `--stat` is cheap and widely supported. Fall back silently.
  const result = runGit(["diff", "--no-color", "--stat"], cwd);
  if (result.ok && result.stdout.trim()) return result.stdout;

  // No unstaged changes — try the staged + untracked view so a freshly
  // committed-then-edited tree still reports something useful.
  const fallback = runGit(["status", "--short"], cwd);
  return fallback.ok ? fallback.stdout : "";
}

function runGit(args: string[], cwd: string): ExecResult {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 15_000 });
  if (result.error) {
    return { ok: false, stdout: "", stderr: result.error.message };
  }
  return { ok: result.status === 0, stdout: result.stdout || "", stderr: result.stderr || "" };
}

/**
 * Port of `scripts/check-complete.sh` advisory output (the non-gate path). The
 * upstream `--gate` path is a Claude Code Stop-hook concern with no Pi
 * equivalent (Pi has no `stop_hook_active` continuation contract), so it is
 * intentionally omitted.
 */
/** Port of `scripts/check-complete.sh` advisory output (the non-gate path). The
 * upstream `--gate` path is a Claude Code Stop-hook concern with no Pi
 * equivalent, so it is intentionally omitted.
 *
 * `costLabel` (PLI v2) optionally appends an injection token-cost line, so
 * /plan-status can surface context cost without this pure module needing the
 * Pi runtime (the command handler computes the mode-aware cost with ctx). */
export function checkCompleteReport(cwd: string, costLabel?: string): string {
  const status = readPlanStatus(cwd);
  const costSuffix = costLabel ? `\n[${PKG_NAME}] Context cost: ${costLabel}.` : "";

  if (!status.exists || status.totalPhases === 0) {
    return `[${PKG_NAME}] No task_plan.md found — no active planning session.${costSuffix}`;
  }

  if (isAllPhasesComplete(status)) {
    return (
      `[${PKG_NAME}] ALL PHASES COMPLETE (${status.completePhases}/${status.totalPhases}). ` +
      "If the user has additional work, add new phases to task_plan.md before starting." +
      costSuffix
    );
  }

  const lines = [
    `[${PKG_NAME}] Task in progress (${status.completePhases}/${status.totalPhases} phases complete). Update progress.md before stopping.`,
  ];
  if (status.inProgressPhases > 0) {
    lines.push(`[${PKG_NAME}] ${status.inProgressPhases} phase(s) still in progress.`);
  }
  if (status.pendingPhases > 0) {
    lines.push(`[${PKG_NAME}] ${status.pendingPhases} phase(s) pending.`);
  }
  if (costLabel) lines.push(`[${PKG_NAME}] Context cost: ${costLabel}.`);
  return lines.join("\n");
}

/** Convenience for the runtime: summarize + completion in one call. */
export function describePlan(status: PlanStatus): string {
  return summarizePlan(status);
}
