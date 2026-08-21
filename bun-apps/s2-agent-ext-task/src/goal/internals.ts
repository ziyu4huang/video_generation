/**
 * internals.ts — the leaf helpers every other goal module calls.
 *
 * Extracted from goal.ts (spec 1a). This is the BOTTOM of the split's import
 * graph and it stays there by construction: nothing here imports a sibling that
 * was carved out of goal.ts. That is what makes the rest of the split acyclic —
 * `hooks`, `lifecycle`, `status` and `prompting` all reach down to this module
 * and never sideways.
 *
 * What lives here is everything that only reads or pokes `goalState`, plus the
 * two plan-coordinator gates and the continuation-marker bookkeeping. The
 * timer-touching helpers (`updateStatus`, `setAndPersistGoal`, `clearActiveGoal`)
 * are deliberately NOT here even though the spec grouped them with these: they
 * call the refresh/heartbeat timers, which call `sendContinuationPrompt`, which
 * calls back into this module. Keeping them in status.ts is what breaks that
 * three-node cycle rather than relying on ES-module function hoisting to hide it.
 */
import { randomUUID } from "crypto";
import { getPlanSummary, isPlanIncomplete } from "../plan/coordinator.js";
import type { ActiveGoal } from "./format.js";
import { goalState } from "./state.js";
import { CONTINUATION_MARKER_PREFIX } from "./prompts.js";
import type { StatusContext } from "./context.js";

/** Cap on remembered cancelled-continuation markers (FIFO eviction below). */
const MAX_CANCELLED_CONTINUATION_PROMPTS = 20;

// ─── Context helpers ──────────────────────────────────────────────────────────

export function hasPendingMessages(ctx: StatusContext) {
	return ctx.hasPendingMessages?.() ?? false;
}

export function abortCurrentTurn(ctx: StatusContext) {
	try {
		ctx.abort?.();
	} catch {
		// Best effort: stale goal guards still prevent follow-on tool calls.
	}
}

export function blockStaleGoalToolCalls() {
	goalState.staleGoalToolCallsBlocked = true;
}

export function clearStaleGoalToolCallBlock() {
	goalState.staleGoalToolCallsBlocked = false;
}

/** Reset the Phase-2 anti-repetition / backoff rolling counters (Task 9). */
export function resetHardeningCounters() {
	goalState.consecutiveStuck = 0;
	goalState.stuckStartedAt = undefined;
	goalState.recentPrints = [];
	goalState.recentTexts = [];
	goalState.recentToolResults = [];
	goalState.toollessStreak = 0;
	goalState.toolRanThisTurn = false;
	goalState.nudgeCount = 0;
}

/** Best-effort stringification of a tool result for fingerprinting. Never throws. */
export function safeStringify(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export function clearGoalRecovery() {
	goalState.goalRecovery = undefined;
}

export function clearGoalRecoveryForGoal(goalId: string) {
	if (goalState.goalRecovery?.goalId === goalId) goalState.goalRecovery = undefined;
}

export function isPiOwnedCompactionRetry(event: unknown, goalId: string) {
	const compaction = event as { reason?: unknown; willRetry?: unknown };
	if (compaction.willRetry === true) return true;
	return (
		goalState.goalRecovery?.goalId === goalId &&
		goalState.goalRecovery.kind === "compaction_retry" &&
		(compaction.reason === undefined || compaction.reason === "overflow")
	);
}
/**
 * Direct internal call to the in-package plan coordinator (ticket 03:
 * self-consume = internal-call, NOT globalThis). Returns an actionable reason
 * string when the active plan has incomplete phases, or undefined if no gate
 * applies (no plan, plan closed, or all phases complete). The coordinator
 * (historical: the coordinator once published a plan-incomplete seam key for
 * wayfind — dead, removed 2026-08-21 D1; this internal call is the live path.)
 */
export function planningGateBlocking(cwd: string): string | undefined {
	return isPlanIncomplete(cwd) ? "the plan still has incomplete phases" : undefined;
}

/**
 * Fusion: direct internal call to the in-package plan coordinator (ticket 03:
 * self-consume = internal-call, NOT globalThis). Surfaces the active plan's
 * phase progress so a goal-driven agent keeps roadmap visibility. Empty string
 * when goalState.latestCtx is unset or no plan is cached. The coordinator publishes
 * (historical: the plan-summary seam key was dead and removed 2026-08-21 D1.)
 */
export function planProgressLineFromPeer(): string {
	const cwd = (goalState.latestCtx as StatusContext | undefined)?.cwd;
	if (!cwd) return "";
	return getPlanSummary(cwd);
}
// ─── Continuation tracking ────────────────────────────────────────────────────

export function clearContinuationTracking() {
	goalState.continuationPending = undefined;
	goalState.cancelledContinuationMarkers.clear();
}

export function cancelContinuationPending() {
	if (goalState.continuationPending) rememberCancelledContinuationMarker(goalState.continuationPending.marker);
	goalState.continuationPending = undefined;
}

export function rememberCancelledContinuationMarker(marker: string) {
	goalState.cancelledContinuationMarkers.add(marker);
	if (goalState.cancelledContinuationMarkers.size <= MAX_CANCELLED_CONTINUATION_PROMPTS) return;
	const oldest = goalState.cancelledContinuationMarkers.values().next().value;
	if (oldest) goalState.cancelledContinuationMarkers.delete(oldest);
}

export function consumeCancelledContinuationPrompt(prompt: string) {
	const marker = extractContinuationMarker(prompt);
	return marker ? goalState.cancelledContinuationMarkers.delete(marker) : false;
}

export function markContinuationDelivered(prompt: string) {
	const marker = extractContinuationMarker(prompt);
	if (marker && goalState.continuationPending?.marker === marker) goalState.continuationPending = undefined;
}

export function continuationMarker(goal: ActiveGoal) {
	return `${goal.id}:${goal.iteration}:${randomUUID()}`;
}

export function escapeRegExpText(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CONTINUATION_MARKER_PATTERN = new RegExp(
	`<!--\\s*${escapeRegExpText(CONTINUATION_MARKER_PREFIX)}([^\\s>]+)\\s*-->`,
);

export function extractContinuationMarker(prompt: string) {
	return CONTINUATION_MARKER_PATTERN.exec(prompt)?.[1];
}

// ─── XML/text helpers ─────────────────────────────────────────────────────────

export function formatError(error: unknown) {
	return truncateNotification(error instanceof Error ? error.message : String(error));
}

export function truncateNotification(value: string) {
	return value.length > 160 ? `${value.slice(0, 157)}...` : value;
}
// ─── Token tracking ───────────────────────────────────────────────────────────

export function currentTokenTotal(ctx: StatusContext): number {
	const sessionManager = ctx.sessionManager as
		| { getBranch?: () => Array<{ type?: string; message?: { role?: string; usage?: unknown } }> }
		| undefined;
	const branch = sessionManager?.getBranch?.() ?? [];
	let total = 0;
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const usage = entry.message.usage as { input?: number; output?: number } | undefined;
		total += usage?.input ?? 0;
		total += usage?.output ?? 0;
	}
	return total;
}
// Transient "✓ goal complete" flash (~8s) shown after goal_complete, then the
// overlay hides itself. The flash timer + render live entirely in GoalOverlay.
// The status-refresh interval (goalState.statusRefreshTimer) is a SEPARATE module-level
// timer that ticks the elapsed-time metric while a goal is active; it is
// stopped on session_shutdown / clearActiveGoal / any non-active transition
// (syncStatusRefreshTimer), so it never goes stale across sessions.
export function showCompletionStatus(_ctx: StatusContext, objective: string) {
	goalState.overlay?.showCompletion(objective);
}