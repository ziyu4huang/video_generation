/**
 * goal/format.ts — pure formatting helpers + the ActiveGoal type.
 *
 * Extracted from goal.ts so both goal.ts (state machine) and overlay.ts
 * (widget rendering) can share them WITHOUT a circular import:
 *
 *   format.ts  ←  overlay.ts
 *   format.ts  ←  goal.ts
 *   overlay.ts ←  goal.ts        (goal.ts owns a GoalOverlay instance)
 *
 * Nothing in format.ts imports goal.ts or overlay.ts.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { GoalAuditorResult } from "./shield.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type GoalStatus = "active" | "paused" | "budget_limited" | "complete";

export interface ActiveGoal {
	id: string;
	text: string;
	status: GoalStatus;
	startedAt: number;
	updatedAt: number;
	iteration: number;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	baselineTokens: number;
	// T04 opt-in auditor (all optional → absent = current behavior, no audit).
	// GoalAuditorResult is imported type-only from ./shield.js, which itself has
	// zero imports — so format.ts stays pi-import-free (Phase-1 invariant).
	auditEnabled?: boolean;
	auditorModel?: string;
	verificationContract?: string;
	auditHistory?: GoalAuditorResult[];
	auditAttempts?: number;
	/** Origin: "list" = promoted from a /list item, "bare" = a plain /goal. Drives the Reviewer `kind`. */
	origin?: "list" | "bare";
}

/**
 * Options that enable + configure the opt-in completion auditor on a goal.
 * Optional 4th param to createGoal: absent → no audit (current pre-T04
 * behavior). The auditor reads auditEnabled/auditorModel/verificationContract
 * off the resulting ActiveGoal. auditHistory/auditAttempts are deliberately
 * NOT part of this options object — they accumulate during auditing and are
 * only ever seeded undefined at creation.
 *
 * Relocated from state.ts (Loop 2, Task 1): GoalListItem needs it, and
 * format.ts cannot import state.ts without a cycle. It is a pure data shape
 * (no pi types), so its canonical home is the pi-import-free format.ts.
 */
export interface GoalAuditOptions {
	auditEnabled?: boolean;
	auditorModel?: string;
	verificationContract?: string;
}

/**
 * A goal-to-be — a tail item in the /list queue. Not a goal yet: it has no
 * status, no usage, no startedAt. It becomes an ActiveGoal via
 * `createGoal(item.text, item.tokenBudget, baseline, item.audit)` when it is
 * promoted to the head. `parked` marks an item parked from a paused activeGoal
 * via `/list next` (preserved across promotion so the cockpit can tell a
 * re-queued item from a fresh one).
 */
export interface GoalListItem {
	id: string;
	text: string;
	tokenBudget?: number;
	audit?: GoalAuditOptions;
	parked?: boolean;
}

// ─── Status word + progress metric (overlay rendering) ───────────────────────

/**
 * The status WORD — what state the goal is in, with no metric attached.
 * Used as the colored head of the overlay line; the metric lives in its own
 * dim segment (formatGoalMetric) so "what state" (colored) is visually separate
 * from "how long / how many tokens" (dim).
 *
 *   "goal active" · "goal paused" · "goal budget reached" · "goal complete"
 */
export function formatStatus(goal: ActiveGoal | undefined): string | undefined {
	if (!goal) return undefined;
	if (goal.status === "complete") return "goal complete";
	if (goal.status === "paused") return "goal paused";
	if (goal.status === "budget_limited") return "goal budget reached";
	return "goal active";
}

/**
 * The progress metric for the overlay's dim segment:
 *   - budget-bearing states (active w/ budget, budget_limited) → "500/2k"
 *   - time-bearing states (active w/o budget, paused) → "1m23s"
 *   - complete → undefined (the completion flash handles display)
 */
export function formatGoalMetric(goal: ActiveGoal | undefined): string | undefined {
	if (!goal) return undefined;
	if (goal.status === "budget_limited" || (goal.status === "active" && goal.tokenBudget !== undefined)) {
		return formatBudget(goal);
	}
	if (goal.status === "active" || goal.status === "paused") {
		return formatDuration(goal.timeUsedSeconds);
	}
	return undefined;
}

export function formatBudget(goal: ActiveGoal): string {
	return `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget ?? 0)}`;
}

export function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

export function formatTokenCount(value: number): string {
	if (value < 1_000) return `${value}`;
	if (value < 1_000_000) return `${Number.isInteger(value / 1_000) ? value / 1_000 : (value / 1_000).toFixed(1)}k`;
	return `${Number.isInteger(value / 1_000_000) ? value / 1_000_000 : (value / 1_000_000).toFixed(1)}m`;
}

// ─── Overlay rendering ────────────────────────────────────────────────────────

/** Theme color for a goal status — drives the overlay icon + status token. */
export function goalStatusColor(status: GoalStatus): ThemeColor {
	if (status === "active") return "accent";
	if (status === "complete") return "success";
	return "warning"; // paused, budget_limited → both need user attention
}

/**
 * Queue suffix state for the overlay line (Loop 2 / Task 7).
 *
 * `position` is 1-based within the head+tail queue (head is always position 1
 * of a bare goal; `headAdvances` from state.ts bumps it as items promote).
 * `total` is `1 + list.length`. Only rendered when `total >= 2` — a bare /goal
 * or a 1-item list is byte-identical to the pre-Loop-2 line (queueSegment="").
 * `parked` counts tail items parked via `/list next`; shown as `· ⚠N parked`.
 */
export interface GoalOverlayQueue {
	position: number;
	total: number;
	parked?: number;
}

/**
 * One-line, theme-colored goal indicator for the below-editor widget:
 *   🎯 goal active · 1m23s · iter 3  <dim objective…>  · ☰ 2/5 · ⚠1 parked
 *
 * The status WORD (goal active / goal paused / goal budget reached) is the
 * colored signal — colored by status (active=accent, paused/budget=warning,
 * complete=success) so paused/budget-reached goals stand out without reading.
 * The metric (elapsed time OR token budget) and iteration count are dim, so
 * "what state" never blurs into "how long / how many tokens".
 *
 * The trailing queue suffix (`· ☰ position/total`, optionally `· ⚠N parked`)
 * is dim and only appears when the queue has >= 2 items (head + >= 1 tail). On
 * narrow terminals it is dropped before truncating the objective so the head
 * (the signal) always survives. With no queue (or total < 2) the line is
 * byte-identical to the pre-Loop-2 output — zero regression for bare /goal.
 */
export function formatGoalOverlayLine(
	goal: ActiveGoal,
	theme: Theme,
	width: number,
	queue?: GoalOverlayQueue,
): string {
	const color = goalStatusColor(goal.status);
	const icon = goal.status === "complete" ? "✓" : "🎯";
	const statusWord = formatStatus(goal) ?? goal.status;
	const metric = formatGoalMetric(goal);
	const sep = ` ${theme.fg("dim", "·")} `;

	// Colored status head first, then dim metrics joined by "·".
	const headParts = [
		`${theme.fg(color, icon)} ${theme.fg(color, statusWord)}`,
		...(metric ? [theme.fg("dim", metric)] : []),
		theme.fg("dim", `iter ${goal.iteration}`),
	];
	const head = headParts.join(sep);

	// Queue suffix (Loop 2 / Task 7): dim "☰ position/total" (+ "⚠N parked").
	// Only when total >= 2 — a bare /goal or 1-item list is byte-identical to before
	// (queueSegment === "" → showQueue === false → unchanged objective width).
	const queueSegment =
		queue && queue.total >= 2
			? `${sep}${theme.fg("dim", `☰ ${queue.position}/${queue.total}`)}${
					queue.parked && queue.parked > 0 ? `${sep}${theme.fg("warning", `⚠${queue.parked} parked`)}` : ""
			  }`
			: "";
	const queueWidth = visibleWidth(queueSegment);

	// Objective fills the remaining width in dim. On narrow terminals, drop it
	// entirely before truncating the status head (the head is the signal).
	const gutter = 2;
	const remaining = width - visibleWidth(head) - gutter;
	if (remaining <= 6) return truncateToWidth(head, width, theme.fg("dim", "…"));
	// Show the queue only if it still leaves > 6 chars of objective; otherwise
	// drop it and let the objective truncate within the full remaining width.
	const showQueue = queueSegment.length > 0 && remaining - queueWidth > 6;
	const objectiveWidth = showQueue ? remaining - queueWidth : remaining;
	const objective = truncateToWidth(goal.text, objectiveWidth, theme.fg("dim", "…"));
	const line = `${head}${" ".repeat(gutter)}${theme.fg("dim", objective)}`;
	return showQueue ? `${line}${queueSegment}` : line;
}

/**
 * Transient "✓ goal complete" flash line shown for ~8s after goal_complete.
 *   ✓ goal complete  <dim objective…>
 */
export function formatGoalCompletionLine(objective: string, theme: Theme, width: number): string {
	const head = `${theme.fg("success", "✓")} ${theme.fg("success", "goal complete")}`;
	const gutter = 2;
	const remaining = width - visibleWidth(head) - gutter;
	if (remaining <= 6) return truncateToWidth(head, width, theme.fg("dim", "…"));
	return `${head}${" ".repeat(gutter)}${theme.fg("dim", truncateToWidth(objective, remaining, theme.fg("dim", "…")))}`;
}
