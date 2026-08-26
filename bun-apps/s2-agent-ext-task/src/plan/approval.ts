/**
 * plan/approval.ts — ExitPlanMode-shaped plan approval (cc-parity ticket 01).
 *
 * CC's plan mode is approval-gated: the plan is shown, the user approves it,
 * and only then does implementation run. s2's coordinator was a passive
 * phase-counter whose only gate was negative (goal_complete blocked while
 * phases are incomplete). This module adds the approval half: a session-scoped
 * record of "the user approved THIS contract of the active plan", consumed by
 * two gates —
 *   • goal_complete (via planningGateBlocking in goal/internals.ts): an
 *     unapproved plan blocks completion with an actionable reason, ahead of
 *     the pre-existing incomplete-phases reason;
 *   • read-only planning (via the tool_call hook in goal/hooks.ts): while a
 *     goal is active against an unapproved plan, the write tools (write/edit)
 *     are blocked — the agent explores read-only until approval lands.
 *
 * Contract fingerprinting: an approval covers the plan's CONTRACT — phase
 * id + title + stepCount — never its progress (completedSteps). Checking a
 * box must not invalidate approval; editing the plan's task list must.
 * A re-prompt fires at most once per contract version (promptedContract),
 * so "do not prompt per turn" holds by construction.
 *
 * Pure module: no fs, no SDK, no globalThis — phases are passed in, state is
 * the module map below (session-scoped like goalState's reviewer toggles,
 * reset via __resetPlanApproval for tests). The interactive confirm itself
 * lives at the call sites (lifecycle.ts entry points, hooks.ts agent_end
 * re-prompt) so this module stays unit-testable under plain Bun.
 */
import type { PlanPhaseInfo } from "./types.js";
import { computeIncomplete } from "./coordinator.js";

/** Contract fingerprint of one phase — identity + shape, NOT progress. */
export function phaseContract(phase: PlanPhaseInfo): string {
	return `${phase.id}|${phase.title}|${phase.stepCount}`;
}

/** Contract fingerprint of a whole plan (phases in order). */
export function planContract(phases: PlanPhaseInfo[]): string {
	return phases.map(phaseContract).join("\n");
}

/** Human-readable phase summary for the approval dialog (CC's plan-file render). */
export function summarizePhases(phases: PlanPhaseInfo[]): string {
	const done = phases.filter((p) => p.status === "completed").length;
	const lines = phases.map((p, i) => {
		const mark = p.status === "completed" ? "x" : p.status === "in_progress" ? "~" : " ";
		return `${i + 1}. [${mark}] ${p.title || p.id} (${p.completedSteps}/${p.stepCount} steps)`;
	});
	return `${done}/${phases.length} phases complete\n${lines.join("\n")}`;
}

interface PlanApprovalRecord {
	/** Contract fingerprint at approval time; undefined = never approved. */
	approvedContract?: string;
	/** Contract fingerprint at the last prompt (approved OR denied) — re-prompt dedupe. */
	promptedContract?: string;
}

/** Session-scoped approval state, keyed per-cwd (worktree-safe). */
const records = new Map<string, PlanApprovalRecord>();

function record(cwd: string): PlanApprovalRecord {
	let r = records.get(cwd);
	if (!r) {
		r = {};
		records.set(cwd, r);
	}
	return r;
}

/** Whether this exact plan contract carries a recorded user approval. */
export function isPlanApproved(cwd: string, phases: PlanPhaseInfo[]): boolean {
	const r = records.get(cwd);
	return r?.approvedContract !== undefined && r.approvedContract === planContract(phases);
}

/**
 * Whether the plan both needs and lacks approval: phases incomplete AND the
 * current contract is not the approved one. This is the read-only-planning
 * and goal_complete-block predicate. A complete plan or an approved contract
 * returns false.
 */
export function planApprovalNeeded(cwd: string, phases: PlanPhaseInfo[]): boolean {
	return computeIncomplete(phases) && !isPlanApproved(cwd, phases);
}

/**
 * Whether an approval prompt should fire NOW: needed AND this contract
 * version has not been prompted before (approved or denied). Gives
 * once-per-contract-version semantics — "do not prompt per turn".
 */
export function shouldPromptForApproval(cwd: string, phases: PlanPhaseInfo[]): boolean {
	return planApprovalNeeded(cwd, phases) && record(cwd).promptedContract !== planContract(phases);
}

/** Record the user's decision on THIS contract version (true = approved). */
export function recordPlanDecision(cwd: string, phases: PlanPhaseInfo[], approved: boolean): void {
	const r = record(cwd);
	r.promptedContract = planContract(phases);
	r.approvedContract = approved ? planContract(phases) : undefined;
}

/** Test seam: reset all approval state. */
export function __resetPlanApproval(): void {
	records.clear();
}
