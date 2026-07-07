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
}

// ─── Compact status token (footer / summary) ─────────────────────────────────

export function formatStatus(goal: ActiveGoal | undefined): string | undefined {
	if (!goal) return undefined;
	// Every token is prefixed with "goal" so the widget line self-documents:
	// "active 1m23s" alone never said *what* is active. "goal active ..." does.
	if (goal.status === "complete") return "goal complete";
	if (goal.status === "paused") return "goal paused";
	if (goal.status === "budget_limited") return `goal budget ${formatBudget(goal)}`;
	if (goal.tokenBudget !== undefined) return `goal active ${formatBudget(goal)}`;
	return `goal active ${formatDuration(goal.timeUsedSeconds)}`;
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
 * One-line, theme-colored goal indicator for the above-editor widget:
 *   🎯 goal active 1m23s · iter 3  <dim objective…>
 *
 * The status token is colored by status (active=accent, paused/budget=warning,
 * complete=success) so paused goals visually stand out without reading.
 */
export function formatGoalOverlayLine(goal: ActiveGoal, theme: Theme, width: number): string {
	const color = goalStatusColor(goal.status);
	const icon = goal.status === "complete" ? "✓" : "🎯";
	const token = formatStatus(goal) ?? goal.status;
	const sep = theme.fg("dim", "·");
	const head = `${theme.fg(color, icon)} ${theme.fg(color, token)} ${sep} ${theme.fg("dim", `iter ${goal.iteration}`)}`;

	// Objective fills the remaining width in dim. On narrow terminals, drop it
	// entirely before truncating the status head (the head is the signal).
	const gutter = 2;
	const remaining = width - visibleWidth(head) - gutter;
	if (remaining <= 6) return truncateToWidth(head, width, theme.fg("dim", "…"));
	const objective = truncateToWidth(goal.text, remaining, theme.fg("dim", "…"));
	return `${head}${" ".repeat(gutter)}${theme.fg("dim", objective)}`;
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
