/**
 * Plan-file resolution and status parsing.
 *
 * Ported from the upstream planning-with-files Pi adapter (v3.4.0). Pure, no Pi
 * dependency — safe to unit-test in isolation.
 *
 * Resolution order (parity with resolve-plan-dir.sh):
 *   1. $PLAN_ID env var           → ./.planning/$PLAN_ID/
 *   2. ./.planning/.active_plan    → ./.planning/<id>/
 *   3. newest ./.planning/<dir>/   (by mtime, that has task_plan.md)
 *   4. legacy ./task_plan.md       (project root)
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export type PlanScope = "scoped" | "root" | "none";

export interface PlanPaths {
  cwd: string;
  scope: PlanScope;
  planPath?: string;
  progressPath?: string;
  findingsPath?: string;
  planDir?: string;
  planId?: string;
  attestationCandidates: string[];
}

export interface PlanStatus extends PlanPaths {
  exists: boolean;
  totalPhases: number;
  completePhases: number;
  inProgressPhases: number;
  pendingPhases: number;
  /** True when at least one phase had a recognizable status token. When false
   * the plan's status format is unparseable and we must NOT treat it as
   * "incomplete" (that produced false-positive "0/N" nags on plans using
   * emoji/inline status conventions the legacy parser didn't recognize). */
  hasParseableStatus: boolean;
  /** True when the plan carries a close marker (`<!-- pwf: closed -->` or a
   * `## Plan Status: closed` heading) written by `/plan-done` or by hand. A
   * closed plan is finished/abandoned: hooks skip it entirely (no injection,
   * no auto-continue, no incomplete nag). */
  closed: boolean;
  firstLines50: string;
  headLines30: string;
  progressTail20: string;
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function resolveNewestPlanDir(planRoot: string): string | undefined {
  if (!existsSync(planRoot)) return undefined;

  const dirs = readdirSync(planRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => join(planRoot, entry.name))
    .filter((dir) => existsSync(join(dir, "task_plan.md")))
    .map((dir) => {
      let mtime = 0;
      try {
        mtime = statSync(dir).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { dir, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);

  return dirs[0]?.dir;
}

export function resolvePlanPaths(cwd: string): PlanPaths {
  const planRoot = join(cwd, ".planning");

  const makeScoped = (planDir: string): PlanPaths => ({
    cwd,
    scope: "scoped",
    planDir,
    planId: basename(planDir),
    planPath: join(planDir, "task_plan.md"),
    progressPath: join(planDir, "progress.md"),
    findingsPath: join(planDir, "findings.md"),
    // Attestation is STRICTLY scope-bound: a scoped plan only ever honors its
    // own <planDir>/.attestation. Including <cwd>/.plan-attestation here (as a
    // migration fallback) caused two bugs once a root plan had been attested in
    // the same cwd: (A) checkPlanAttestation picked up the stale root hash and
    // reported every scoped plan as [PLAN TAMPERED]; (B) pickWritePath's
    // "reuse existing candidate" rule made /plan-attest on a scoped plan
    // clobber the root file instead of creating <planDir>/.attestation.
    attestationCandidates: [join(planDir, ".attestation")],
  });

  const makeRoot = (): PlanPaths => ({
    cwd,
    scope: "root",
    planPath: join(cwd, "task_plan.md"),
    progressPath: join(cwd, "progress.md"),
    findingsPath: join(cwd, "findings.md"),
    attestationCandidates: [join(cwd, ".plan-attestation")],
  });

  const planId = process.env.PLAN_ID?.trim();
  if (planId) {
    const candidate = join(planRoot, planId);
    if (existsSync(join(candidate, "task_plan.md"))) {
      return makeScoped(candidate);
    }
  }

  const activePlanFile = join(planRoot, ".active_plan");
  if (existsSync(activePlanFile)) {
    const activePlanId = safeRead(activePlanFile).trim();
    if (activePlanId) {
      const candidate = join(planRoot, activePlanId);
      if (existsSync(join(candidate, "task_plan.md"))) {
        return makeScoped(candidate);
      }
    }
  }

  const newest = resolveNewestPlanDir(planRoot);
  if (newest) {
    return makeScoped(newest);
  }

  const rootPlan = makeRoot();
  if (rootPlan.planPath && existsSync(rootPlan.planPath)) {
    return rootPlan;
  }

  return {
    cwd,
    scope: "none",
    attestationCandidates: [join(cwd, ".plan-attestation")],
  };
}

type PhaseStatus = "complete" | "in_progress" | "pending" | "unknown";

/**
 * Classify a single phase block's status from its header + body. Recognition
 * priority (first hit wins):
 *   1. `**Status:** complete|in_progress|pending`  (primary, anywhere in block)
 *   2. `[complete]` / `[in_progress]` / `[pending]`  (inline bracket form)
 *   3. Emoji status markers anywhere in the block (human-writable conventions):
 *        ✅ / ✔ / 🟢            → complete
 *        🔄 / ⏳ / 🏗 / 🚧 / 🛠  → in_progress
 *        ⏸ / 🔒 / 🚫 / ❌       → pending (blocked / abandoned)
 *
 * A block with no recognizable token returns "unknown" so the caller can tell
 * "definitely has status" from "status format not understood" — the latter must
 * not be miscounted as "0/N incomplete" (which caused false-positive nags).
 *
 * Note: we deliberately do NOT match bare status words (e.g. "complete the X")
 * outside of a Status:/bracket/emoji context, to avoid false positives from
 * prose that merely contains the word.
 */
function classifyPhaseStatus(header: string, body: string[]): PhaseStatus {
  const combined = `${header}\n${body.join("\n")}`;

  // 1. Primary `**Status:** X` (case-insensitive).
  if (/\*\*Status:\*\*\s*complete\b/i.test(combined)) return "complete";
  if (/\*\*Status:\*\*\s*in[-_ ]?progress\b/i.test(combined)) return "in_progress";
  if (/\*\*Status:\*\*\s*pending\b/i.test(combined)) return "pending";

  // 2. Inline bracket form `[complete]` etc.
  if (/\[complete\]/i.test(combined)) return "complete";
  if (/\[in[-_ ]?progress\]/i.test(combined)) return "in_progress";
  if (/\[pending\]/i.test(combined)) return "pending";

  // 3. Emoji status markers (unambiguous — only used as status indicators).
  //    The `u` flag is required so astral-plane emoji (🔄 U+1F504, 🚧 U+1F6A7,
  //    …) are matched as whole code points rather than surrogate pairs.
  if (/[✅✔🟢]/u.test(combined)) return "complete";
  if (/[🔄⏳🏗🚧🛠]/u.test(combined)) return "in_progress";
  if (/[⏸🔒🚫❌]/u.test(combined)) return "pending";

  return "unknown";
}

/** True when the raw plan content carries a close marker. Recognizes both the
 * inert comment form written by `/plan-done` and a human-writable heading. */
export function isCloseMarker(planContent: string): boolean {
  return (
    /<!--\s*pwf:\s*closed\s*-->/i.test(planContent) ||
    /^##\s+plan\s+status:\s*\**\s*closed\s*\**\s*$/im.test(planContent)
  );
}

export function readPlanStatus(cwd: string): PlanStatus {
  const paths = resolvePlanPaths(cwd);
  if (!paths.planPath || !existsSync(paths.planPath)) {
    return {
      ...paths,
      exists: false,
      totalPhases: 0,
      completePhases: 0,
      inProgressPhases: 0,
      pendingPhases: 0,
      hasParseableStatus: false,
      closed: false,
      firstLines50: "",
      headLines30: "",
      progressTail20: "",
    };
  }

  const planContent = safeRead(paths.planPath);
  const lines = planContent.split("\n");

  const phaseRegex = /^###\s+Phase\b/i;

  // Parse phase-by-phase so each block is classified independently. This is a
  // strict improvement over the legacy global counter: it correctly handles
  // mixed Status:/bracket formats within one plan, and it lets per-block emoji
  // markers (✅/⏸/🔄) be attributed to the right phase instead of being missed.
  const blocks: { header: string; body: string[] }[] = [];
  let current: { header: string; body: string[] } | null = null;
  for (const line of lines) {
    if (phaseRegex.test(line)) {
      if (current) blocks.push(current);
      current = { header: line, body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) blocks.push(current);

  const total = blocks.length;
  let complete = 0;
  let inProgress = 0;
  let pending = 0;

  for (const block of blocks) {
    const classified = classifyPhaseStatus(block.header, block.body);
    if (classified === "complete") complete += 1;
    else if (classified === "in_progress") inProgress += 1;
    else if (classified === "pending") pending += 1;
  }

  let progressTail20 = "";
  if (paths.progressPath && existsSync(paths.progressPath)) {
    const progressLines = safeRead(paths.progressPath).split("\n");
    progressTail20 = progressLines.slice(-20).join("\n");
  }

  return {
    ...paths,
    exists: true,
    totalPhases: total,
    completePhases: complete,
    inProgressPhases: inProgress,
    pendingPhases: pending,
    hasParseableStatus: complete + inProgress + pending > 0,
    closed: isCloseMarker(planContent),
    firstLines50: lines.slice(0, 50).join("\n"),
    headLines30: lines.slice(0, 30).join("\n"),
    progressTail20,
  };
}

export function isAllPhasesComplete(status: PlanStatus): boolean {
  return status.exists && !status.closed && status.totalPhases > 0 && status.completePhases >= status.totalPhases;
}

export function isPlanIncomplete(status: PlanStatus): boolean {
  // Don't nag when the status format is unparseable (no phase had a recognized
  // token) — that previously produced false "0/N incomplete" warnings on plans
  // using conventions the parser didn't understand. Also never nag a closed
  // plan (finished/abandoned via /plan-done).
  if (status.closed || !status.hasParseableStatus) return false;
  return status.exists && status.totalPhases > 0 && status.completePhases < status.totalPhases;
}

/** True when the plan is explicitly closed (finished/abandoned). The runtime
 * treats a closed plan as inert: no injection, no auto-continue, no nag. */
export function isPlanClosed(status: PlanStatus): boolean {
  return status.exists && status.closed;
}

export function isSessionAttached(cwd: string, sessionId: string | undefined): boolean {
  const sessionsDir = join(cwd, ".planning", "sessions");
  if (!existsSync(sessionsDir)) return true;
  if (!sessionId) return false;
  return existsSync(join(sessionsDir, `${sessionId}.attached`));
}

/** One-line status summary, e.g. "1/2 phases complete". Pure + testable. */
export function summarizePlan(status: PlanStatus): string {
  if (!status.exists) return "No active task_plan.md";
  if (status.closed) return "Plan closed (via /plan-done)";
  if (status.totalPhases <= 0) return "task_plan.md detected (no phase headers yet)";
  if (!status.hasParseableStatus) return `${status.totalPhases} phases (status format unrecognized)`;
  return `${status.completePhases}/${status.totalPhases} phases complete`;
}
