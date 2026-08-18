/**
 * status.ts — the overlay/timer half of goal state: what the widget shows, the
 * two intervals that keep it honest, and the teardown that stops both.
 *
 * Extracted from goal.ts (spec 1a), which planned this as `timers.ts` holding
 * only the two intervals. `updateStatus`, `setAndPersistGoal` and
 * `clearActiveGoal` were planned for `internals.ts` and moved here instead,
 * because all three call the timer syncs — and the heartbeat timer calls
 * `sendContinuationPrompt`, which calls back into internals. Grouped the
 * planned way the graph is internals -> status -> prompting -> internals, a
 * cycle; grouped this way it is a DAG.
 *
 * `clearActiveGoal` is here for the same reason: it stops both timers.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ActiveGoal } from "./format.js";
import { goalState } from "./state.js";
import type { StatusContext } from "./context.js";
import {
	clearPersistedGoal,
	loadGoalStateFromSession,
	persistGoal,
	persistGoalState,
	shouldHonorPersistedStatus,
} from "./persistence.js";
import { isLoopActive, refireLoopContinuation } from "../loop/loop.js";
import {
	HEARTBEAT_INTERVAL_MS,
	shouldHeartbeatRefire,
	shouldWedgeAlert,
	WEDGE_ALERT_DEFAULT_MINUTES,
} from "./backoff.js";
import {
	cancelContinuationPending,
	clearGoalRecovery,
	clearStaleGoalToolCallBlock,
	currentTokenTotal,
} from "./internals.js";
import { sendContinuationPrompt } from "./prompting.js";

/** How often the overlay re-reads elapsed time / token usage while active. */
const STATUS_REFRESH_INTERVAL_MS = 1_000;

// ─── Status helpers ───────────────────────────────────────────────────────────
// The GoalOverlay widget is the single UI surface for goal state. These are
// thin delegates so command handlers / lifecycle hooks / agent_end read cleanly
// while updateStatus keeps its (_ctx, goal) call sites unchanged.

export function updateStatus(ctx: StatusContext, _goal: ActiveGoal | undefined) {
	goalState.latestCtx = ctx;
	goalState.overlay?.update(goalState.activeGoal, goalState.list, goalState.headAdvances);
	syncStatusRefreshTimer();
	syncHeartbeatTimer();
}

/** Persist a goal to the ledger AND refresh the overlay/status timers in one
 *  call. Collapses the 20 identical `persistGoal(...)` + `updateStatus(ctx, …)`
 *  pairs scattered across the command handlers into a single readable call. */
export function setAndPersistGoal(goal: ActiveGoal, ctx: StatusContext): void {
	persistGoal(goalState.extensionApi as ExtensionAPI, goal);
	updateStatus(ctx, goal);
}
/**
 * Keep the active-goal overlay ticking. Without this, `timeUsedSeconds` is a
 * frozen snapshot (only recomputed at agent_end / compact), so a long active
 * turn shows "goal active · 0s · iter 0" for its whole duration. The tick
 * recomputes elapsed time (and token usage) live and pokes the overlay, whose
 * `refresh()` re-renders the widget. Not persisted — persistence stays at
 * agent_end / compact to avoid flooding the session log.
 */
export function tickActiveGoalStatus() {
	if (!goalState.activeGoal || goalState.activeGoal.status !== "active" || !goalState.latestCtx) return;
	goalState.activeGoal.timeUsedSeconds = Math.max(0, Math.floor((Date.now() - goalState.activeGoal.startedAt) / 1000));
	goalState.activeGoal.tokensUsed = Math.max(0, currentTokenTotal(goalState.latestCtx as StatusContext) - goalState.activeGoal.baselineTokens);
	goalState.activeGoal.updatedAt = Date.now();
	goalState.overlay?.update(goalState.activeGoal);
}

export function stopStatusRefreshTimer() {
	if (!goalState.statusRefreshTimer) return;
	clearInterval(goalState.statusRefreshTimer);
	goalState.statusRefreshTimer = undefined;
}

/** Start a 1s refresh interval only while a goal is active; stop otherwise. */
export function syncStatusRefreshTimer() {
	const shouldRun = goalState.activeGoal?.status === "active";
	if (shouldRun && !goalState.statusRefreshTimer) {
		goalState.statusRefreshTimer = setInterval(tickActiveGoalStatus, STATUS_REFRESH_INTERVAL_MS);
		// Never keep the process alive just for the status ticker (tests, -p batch).
		goalState.statusRefreshTimer?.unref?.();
	} else if (!shouldRun && goalState.statusRefreshTimer) {
		stopStatusRefreshTimer();
	}
}

export function stopHeartbeatTimer() {
	if (!goalState.heartbeatTimer) return;
	clearInterval(goalState.heartbeatTimer);
	goalState.heartbeatTimer = undefined;
}

/**
 * Start a HEARTBEAT_INTERVAL_MS self-watchdog only while a goal is active.
 * Each tick evaluates two pure predicates (./backoff.js):
 *   - shouldHeartbeatRefire: the session is idle, no continuation is pending,
 *     and msSinceActivity >= HEARTBEAT_STALL_MS (120s) -> re-fire the
 *     continuation (recovery for a compaction-eaten turn or a dropped message).
 *   - shouldWedgeAlert: the session is BUSY and has been silent >= 30m -> a
 *     single long-running command may be wedging the session; notify (throttled
 *     to once per threshold via lastWedgeAlertAt).
 * Never keeps the process alive (.unref). The re-fire is idempotent: sendContinuationPrompt's
 * continuationPending guard prevents duplicate continuations within one tick window.
 */
export function syncHeartbeatTimer() {
	const shouldRun = goalState.activeGoal?.status === "active" || isLoopActive();
	if (shouldRun && !goalState.heartbeatTimer) {
		goalState.heartbeatTimer = setInterval(() => {
			const ctx = goalState.latestCtx as StatusContext | undefined;
			if (!ctx) return;
			if (
				shouldHeartbeatRefire({
					supervising: true,
					sessionIdle: !!ctx.isIdle?.(),
					timerPending: !!goalState.continuationPending,
					msSinceActivity: Date.now() - goalState.lastActivityAt,
				})
			) {
				if (isLoopActive()) {
					void refireLoopContinuation((goalState.extensionApi as ExtensionAPI), ctx as StatusContext);
				} else if (goalState.activeGoal?.status === "active") {
					const persisted = loadGoalStateFromSession(ctx.sessionManager);
					if (shouldHonorPersistedStatus(goalState.activeGoal, persisted.goal)) {
						goalState.activeGoal = persisted.goal;
						stopHeartbeatTimer();
						return;
					}
					void sendContinuationPrompt((goalState.extensionApi as ExtensionAPI), ctx, goalState.activeGoal);
				}
			}
			if (
				shouldWedgeAlert({
					supervising: true,
					sessionBusy: !ctx.isIdle?.(),
					silentMs: Date.now() - goalState.lastActivityAt,
					msSinceLastAlert: Date.now() - goalState.lastWedgeAlertAt,
					thresholdMs: WEDGE_ALERT_DEFAULT_MINUTES * 60_000,
				})
			) {
				goalState.lastWedgeAlertAt = Date.now();
				ctx.ui.notify(
					`Goal wedge: no activity for ${WEDGE_ALERT_DEFAULT_MINUTES}m. A long command may be holding the session.`,
					"warning",
				);
			}
		}, HEARTBEAT_INTERVAL_MS);
		// Never keep the process alive just for the heartbeat (tests, -p batch).
		goalState.heartbeatTimer?.unref?.();
	} else if (!shouldRun && goalState.heartbeatTimer) {
		stopHeartbeatTimer();
	}
}
// ─── Persistence ──────────────────────────────────────────────────────────────
// persistGoal / clearPersistedGoal / loadGoalStateFromSession live in ./persistence.ts
// (deps injected: api / sessionManager passed as params; no module-state reads;
// session-store-only since Task 11 retired the legacy state file) — imported above.

export function clearActiveGoal(_ctx: StatusContext, opts: { preserveList?: boolean } = {}) {
	cancelContinuationPending();
	clearGoalRecovery();
	clearStaleGoalToolCallBlock();
	goalState.activeGoal = undefined;
	if (opts.preserveList && goalState.list.length > 0) {
		// Keep the reviewer-enqueued follow-ups as the new queue tail (Task 5):
		// persist {goal:null, list} so a reload restores the tail without a
		// phantom head, and leave headAdvances so the widget position stays sane.
		persistGoalState(goalState.extensionApi as ExtensionAPI, null, goalState.list);
	} else {
		// The in-memory queue tail + headAdvances are queue-lifecycle state — reset
		// here (and at every other lifecycle boundary) so they cannot leak across a
		// fresh /goal. clearActiveGoal runs on /goal clear (with an active head), on
		// a drained goal_complete, and on session teardown paths.
		goalState.list = [];
		goalState.headAdvances = 0;
		clearPersistedGoal(goalState.extensionApi as ExtensionAPI);
	}
	goalState.overlay?.update(undefined);
	stopStatusRefreshTimer();
	stopHeartbeatTimer();
}