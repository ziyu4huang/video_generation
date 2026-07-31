/**
 * goal/prompts.ts — pure prompt-builder helpers extracted from goal.ts.
 *
 * Phase 1, Task 3: every prompt template + the objective/escape/marker-comment
 * helpers move here so the state machine in goal.ts shrinks toward pure
 * lifecycle wiring. This module has ZERO `@earendil-works/*` imports — it only
 * imports the `ActiveGoal` / `GoalStatus` types and formatting helpers from the
 * sibling `format.js` (a leaf module with no cycle back into goal.ts).
 *
 * PURITY WRINKLE — the plan-progress line is INJECTED, not read:
 *   `buildGoalSystemPrompt` and `buildContinuePrompt` previously called
 *   `planProgressLineFromPeer()` themselves; that function reads module state
 *   (`latestCtx`) in goal.ts, so it is NOT pure and stays in goal.ts. To keep
 *   this module pure, both builders now take the already-computed
 *   `planProgressLine: string` as a parameter. goal.ts passes the live result
 *   of `planProgressLineFromPeer()` at each call site.
 *
 * The continuation-marker GENERATION / EXTRACTION machinery (the regex,
 * escapeRegExpText, continuationMarker, extractContinuationMarker) stays in
 * goal.ts; only the string formatter `continuationMarkerComment` moves here,
 * and it owns the shared `CONTINUATION_MARKER_PREFIX` constant (exported back
 * to goal.ts so the extraction regex stays in sync).
 */

import {
	formatBudget,
	formatDuration,
	formatTokenCount,
	type ActiveGoal,
	type GoalStatus,
} from "./format.js";

// ─── Continuation-marker prefix (shared with goal.ts machinery) ──────────────

/**
 * Marker prefix that ties an auto-continuation prompt to the goal iteration
 * that issued it. Owned here because `continuationMarkerComment` formats it;
 * goal.ts imports it for the extraction regex + the (id:iter:uuid) generator.
 */
export const CONTINUATION_MARKER_PREFIX = "pi-goal-continuation:";

// ─── Three-layer fusion guidance ─────────────────────────────────────────────

// Three-layer fusion guidance: teaches the agent that the plan coordinator (the
// roadmap) and the `todo` tool (in-session steps) are tools to FINISH the goal,
// not stopping points. Goal drives; the other two structure the drive.
export const THREE_LAYER_GUIDANCE =
	"You have three cooperating layers: this /goal (drives to completion), " +
	"the plan coordinator (the cross-session phase roadmap in task_plan.md), and " +
	"the `todo` tool (in-session step tracking). Use the plan as your roadmap " +
	"and todo to track steps — neither is a stopping point; they are tools to finish this goal.";

// ─── XML/text helpers ─────────────────────────────────────────────────────────

export function escapeXmlText(value: string) {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Objective + persistence blocks ─────────────────────────────────────────

export function goalObjectiveBlock(goal: ActiveGoal) {
	return `<goal_objective>\n${escapeXmlText(goal.text)}\n</goal_objective>`;
}

export function goalPersistenceRules(goalLabel: string) {
	return `Keep going until ${goalLabel} is completely resolved end-to-end. Do not redefine ${goalLabel} into a smaller task. Do not stop at analysis, a plan, TODO list, partial fixes, or suggested next steps. Autonomously perform implementation and verification with the available tools when they are needed. Treat the current worktree, command output, tests, and external state as authoritative. If a tool call fails, try reasonable alternatives instead of yielding early. Before calling goal_complete, audit ${goalLabel} requirement by requirement against the verified current state. Only call the goal_complete tool after ${goalLabel} is fully complete and verified.`;
}

// ─── Continuation-marker comment formatter ──────────────────────────────────

export function continuationMarkerComment(marker: string) {
	return `<!-- ${CONTINUATION_MARKER_PREFIX}${marker} -->`;
}

// ─── Prompt templates ────────────────────────────────────────────────────────

export function buildGoalPrompt(goal: ActiveGoal) {
	const budgetLine = goal.tokenBudget === undefined ? "" : `\nToken budget: ${formatTokenCount(goal.tokenBudget)}.`;
	return `Goal mode is active. Complete this goal fully:\n\n${goalObjectiveBlock(goal)}${budgetLine}\n\n${goalPersistenceRules("this goal")}`;
}

export function buildObjectiveUpdatedPrompt(goal: ActiveGoal) {
	const budgetLine = goal.tokenBudget === undefined ? "" : `\nToken budget: ${formatBudget(goal)} used.`;
	return `The active /goal objective was updated. Continue working toward this goal:\n\n${goalObjectiveBlock(goal)}${budgetLine}\n\n${goalPersistenceRules("the updated goal")}`;
}

export function buildResumePrompt(goal: ActiveGoal) {
	const budgetLine = goal.tokenBudget === undefined ? "" : `\nToken budget: ${formatBudget(goal)} used.`;
	return `The user explicitly resumed the paused /goal. Continue working toward this goal:\n\n${goalObjectiveBlock(goal)}${budgetLine}\n\n${goalPersistenceRules("this goal")}`;
}

/**
 * Goal-mode system-prompt injected at `before_agent_start`.
 *
 * `planProgressLine` is the already-computed roadmap progress (or "") —
 * goal.ts passes `planProgressLineFromPeer()` here. Injected (not read inside)
 * so this module stays free of module-state reads and is unit-testable in
 * isolation.
 */
export function buildGoalSystemPrompt(goal: ActiveGoal, planProgressLine: string) {
	const budgetLine = goal.tokenBudget === undefined ? "" : `\n- Respect the goal token budget (${formatBudget(goal)} used).`;
	const planBullet = planProgressLine ? `\n- Active plan progress: ${planProgressLine}. Treat the plan as your roadmap, not a stopping point.` : "";
	return `Active /goal:\n${goalObjectiveBlock(goal)}\n\nGoal-mode rules:\n- Keep going until the active goal is completely resolved end-to-end.\n- Treat the current worktree, command output, tests, and external state as authoritative.\n- Do not redefine the goal into a smaller task; audit every requirement before completion.\n- Do not stop at analysis, a plan, TODO list, partial fixes, or suggested next steps.\n- ${THREE_LAYER_GUIDANCE}\n- Autonomously perform implementation and verification with the available tools when they are needed to complete the goal.\n- Persevere through recoverable tool failures by trying reasonable alternatives instead of yielding early.\n- If the goal is not complete at the end of a turn, expect an automatic continuation and keep working from where you left off.\n- Only call the goal_complete tool after the goal is fully complete and verified.${planBullet}${budgetLine}`;
}

/**
 * Auto-continuation prompt sent between turns while the goal stays active.
 *
 * `planProgressLine` is the already-computed roadmap progress (or "") —
 * goal.ts passes `planProgressLineFromPeer()` here. Injected (not read inside)
 * so this module stays free of module-state reads.
 */
export function buildContinuePrompt(goal: ActiveGoal, marker: string, planProgressLine: string) {
	const planNote = planProgressLine ? `\nActive plan progress: ${planProgressLine}. Continue the next open phase, then mark it complete in task_plan.md.` : "";
	return `Continue the active /goal until it is complete:\n\n${goalObjectiveBlock(goal)}\n\nThis is automatic continuation #${goal.iteration}. Current files, command output, tests, and external state are authoritative; re-check them as needed. ${goalPersistenceRules("this goal")}${planNote}\n\n${continuationMarkerComment(marker)}`;
}

// ─── Status summary (command hint + one-line summary) ────────────────────────

export function goalCommandHint(status: GoalStatus) {
	if (status === "active") return "/goal edit <objective>, /goal pause, /goal clear";
	if (status === "paused") return "/goal edit <objective>, /goal resume, /goal clear";
	return "/goal edit <objective>, /goal clear";
}

export function goalSummary(
	goal: ActiveGoal,
	lastReview?: { cascadeStep?: string; enqueued?: number; proposed?: number; reportPath?: string },
) {
	const lines = [
		`Goal: ${goal.text}`,
		`Status: ${goal.status}`,
		`Iteration: ${goal.iteration}`,
		`Elapsed: ${formatDuration(goal.timeUsedSeconds)}`,
		`Tokens: ${goal.tokenBudget === undefined ? formatTokenCount(goal.tokensUsed) : formatBudget(goal)}`,
		`Commands: ${goalCommandHint(goal.status)}`,
	];

	if (lastReview && lastReview.cascadeStep) {
		const reviewParts = [` · review: ${lastReview.cascadeStep}`];
		if (lastReview.enqueued !== undefined) {
			reviewParts.push(` (${lastReview.enqueued} enqueued`);
			if (lastReview.proposed !== undefined) {
				reviewParts.push(`, ${lastReview.proposed} proposed`);
			}
			reviewParts.push(")");
		}
		lines[lines.length - 1] += reviewParts.join("");
	}

	return lines.join("\n");
}
