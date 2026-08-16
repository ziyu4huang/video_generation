/**
 * hooks.ts — the nine session/agent lifecycle handlers goal() registers.
 *
 * Extracted from goal.ts (spec 1a), where they were nine inline `pi.on(...)`
 * closures inside the entry point — `agent_end` alone ran ~145 lines, which is
 * why reading goal() meant reading the whole hardening pipeline.
 *
 * The spec named the import cycle here as the split's one real risk:
 * these handlers need the shared tail helpers, and goal() needs this
 * registration. It is resolved by direction, not by ordering — everything this
 * module calls lives BELOW it (internals, status, prompting, lifecycle), and
 * goal.ts calls in one way only, via registerGoalHooks().
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatBudget, type ActiveGoal } from "./format.js";
import { goalState, incrementGoal, transitionGoal } from "./state.js";
import { clearPersistedGoal, loadGoalStateFromSession, persistGoal } from "./persistence.js";
import { isLoopActive, runLoopTick } from "../loop/loop.js";
import {
	accountTurnForNudges,
	HEARTBEAT_MAX_NUDGES,
	shouldPauseAfterBackoff,
} from "./backoff.js";
import {
	findFinalAssistantMessage,
	isGoalContextOverflow,
	isRetryableGoalInterruption,
} from "./overflow.js";
import {
	detectLoopStuck,
	loopInterventionDirective,
	pushCapped,
	REPETITION,
	textFingerprint,
} from "./repetition.js";
import { LENGTH_CONTINUE_MAX, resetLengthContinue, tickLengthContinue } from "./length-continue.js";
import { cancelQuotaRetry } from "./quota-retry.js";
import { buildGoalSystemPrompt } from "./prompts.js";
import type { StatusContext } from "./context.js";
import {
	blockStaleGoalToolCalls,
	cancelContinuationPending,
	clearContinuationTracking,
	clearGoalRecovery,
	clearGoalRecoveryForGoal,
	clearStaleGoalToolCallBlock,
	consumeCancelledContinuationPrompt,
	hasPendingMessages,
	isPiOwnedCompactionRetry,
	markContinuationDelivered,
	planProgressLineFromPeer,
	resetHardeningCounters,
	safeStringify,
} from "./internals.js";
import {
	clearActiveGoal,
	setAndPersistGoal,
	stopHeartbeatTimer,
	stopStatusRefreshTimer,
	syncHeartbeatTimer,
	updateStatus,
} from "./status.js";
import { sendContinuationPrompt, sendLengthContinue, sendPrompt } from "./prompting.js";
import { pauseGoalAfterAgentEnd, updateGoalUsage } from "./lifecycle.js";

/** Register every session/agent hook the goal subsystem listens on. */
export function registerGoalHooks(pi: ExtensionAPI): void {

	pi.on("session_start", (_event: unknown, ctx: StatusContext) => {
		// Reset the overlay for the fresh session: rebind the UI ctx and drop any
		// stale completion flash left over from the previous session.
		// Capture latestCtx unconditionally: the generalized heartbeat (Task 8)
		// supervises a goal XOR a loop and reads latestCtx for its tick callback,
		// so it must be set even when no goal is restored (loop-only session).
		goalState.latestCtx = ctx;
		goalState.overlay?.setUICtx(ctx.ui);
		stopStatusRefreshTimer();
		clearContinuationTracking();
		clearGoalRecovery();
		clearStaleGoalToolCallBlock();
		cancelQuotaRetry(); // quota-retry: fresh session, no stale scheduled resume
		resetLengthContinue(); // length-continue: fresh session, fresh truncation streak
		const restored = loadGoalStateFromSession(ctx.sessionManager);
		goalState.activeGoal = restored.goal;
		goalState.list = restored.list ?? [];
		if (goalState.activeGoal) updateStatus(ctx, goalState.activeGoal);
		else goalState.overlay?.update(undefined);
	});

	pi.on("session_shutdown", (_event: unknown, _ctx: StatusContext) => {
		if (goalState.activeGoal) persistGoal(goalState.extensionApi as ExtensionAPI, goalState.activeGoal);
		clearContinuationTracking();
		clearGoalRecovery();
		clearStaleGoalToolCallBlock();
		stopStatusRefreshTimer();
		stopHeartbeatTimer();
		goalState.overlay?.dispose();
		// Clear the heartbeat coordination seam for symmetry with publish
		delete (globalThis as Record<string, unknown>).__piKickHeartbeat;
	});

	pi.on("session_before_compact", (_event: unknown, ctx: StatusContext) => {
		if (!goalState.activeGoal || goalState.activeGoal.status !== "active") return;
		updateGoalUsage(goalState.activeGoal, ctx);
		cancelContinuationPending();
		setAndPersistGoal(goalState.activeGoal, ctx);
	});

	pi.on("session_compact", async (event: unknown, ctx: StatusContext) => {
		if (!goalState.activeGoal || goalState.activeGoal.status !== "active") {
			clearGoalRecovery();
			return;
		}

		const restoredState = loadGoalStateFromSession(ctx.sessionManager);
		if (restoredState.goal?.id === goalState.activeGoal.id) goalState.activeGoal = restoredState.goal;
		goalState.list = restoredState.list ?? goalState.list;
		updateGoalUsage(goalState.activeGoal, ctx);
		setAndPersistGoal(goalState.activeGoal, ctx);

		const wasPiRetry = isPiOwnedCompactionRetry(event, goalState.activeGoal.id);
		clearGoalRecoveryForGoal(goalState.activeGoal.id);
		if (wasPiRetry || hasPendingMessages(ctx)) return;
		await sendContinuationPrompt(pi, ctx, goalState.activeGoal);
	});

	pi.on("input", (event: { source?: string; text?: string }) => {
		if (event.source === "extension") {
			if (event.text && consumeCancelledContinuationPrompt(event.text)) return { action: "handled" as const };
			return;
		}
		// Task 10: user input is a liveness signal — reset the stall clock so the
		// heartbeat does not fire a nudge while the user is actively typing.
		goalState.lastActivityAt = Date.now();
		clearGoalRecovery();
		clearStaleGoalToolCallBlock();
	});

	pi.on("tool_call", () => {
		if (!goalState.staleGoalToolCallsBlocked) return;
		if (!goalState.activeGoal || goalState.activeGoal.status !== "paused") {
			clearStaleGoalToolCallBlock();
			return;
		}
		return {
			block: true,
			reason: "Blocked stale /goal tool call after the goal was paused or interrupted.",
		};
	});

	// Phase-2 hardening (Task 9): a tool ran this turn → reset the narration-only
	// streak and fingerprint the tool's output into the rolling window. The
	// classifier (detectLoopStuck, in agent_end) reads both. Fingerprints the
	// serialized result so repeated identical outputs (e.g. an error the agent
	// keeps re-triggering, or a no-op read) surface as "no new information".
	pi.on("tool_execution_end", (event: { toolName: string; result?: unknown; isError?: boolean }) => {
		// Skip the (cheap-but-wasteful) fingerprint work when no goal is active.
		if (!goalState.activeGoal) return;
		// Task 10: a tool call is the strongest liveness signal — stamp it so the
		// heartbeat watchdog does not mistake an active turn for a stall.
		goalState.lastActivityAt = Date.now();
		// Per-turn flag (Task 9 fix): agent_end consumes + clears this so
		// toollessStreak counts *consecutive* toolless turns rather than being
		// unconditionally bumped every turn (which made it off-by-one and
		// tripped the stuck threshold on the first legitimate narration turn).
		goalState.toolRanThisTurn = true;
		const hash = textFingerprint(safeStringify(event.result));
		goalState.recentToolResults = pushCapped(
			goalState.recentToolResults,
			{ tool: event.toolName, hash, isError: Boolean(event.isError) },
			REPETITION.toolWindow,
		);
	});

	pi.on("before_agent_start", (event: { systemPrompt?: string; prompt?: string }) => {
		if (event.prompt) markContinuationDelivered(event.prompt);
		if (!goalState.activeGoal || goalState.activeGoal.status !== "active") return;

		return {
			systemPrompt: `${event.systemPrompt ?? ""}\n\n${buildGoalSystemPrompt(goalState.activeGoal, planProgressLineFromPeer())}`,
		};
	});

	pi.on("agent_end", async (event: { messages?: unknown[] }, ctx: StatusContext) => {
		// length-continue (folded-in, GLA faithful baseline): a truncated turn is
		// NOT a completed turn — re-trigger with split-smaller guidance and skip
		// ALL turn bookkeeping (no liveness stamp, no incrementGoal, no usage, no
		// nudge/repetition, no continuation). Placed before the loop dispatch and
		// the no-goal bail so it also covers /loop and plain (no-goal) sessions.
		const finalAssistant = findFinalAssistantMessage(event.messages ?? []);
		const lc = tickLengthContinue(finalAssistant?.stopReason === "length");
		if (lc.giveUpNow) {
			ctx.ui.notify(
				`Response hit the output-token cap ${LENGTH_CONTINUE_MAX}× in a row — stepping aside from auto-continue. Ask the model to split the work into smaller pieces.`,
				"warning",
			);
		}
		if (finalAssistant?.stopReason === "length") {
			if (lc.fire && !hasPendingMessages(ctx)) sendLengthContinue(pi, ctx, lc.consecutive);
			return;
		}

		// Loop 3 dispatch: a live loop drives the continuation, not a goal.
		if (isLoopActive()) {
			await runLoopTick(pi, ctx as StatusContext, event);
			return;
		}
		if (!goalState.activeGoal || goalState.activeGoal.status !== "active") return;
		// (the prior `const finalAssistant = findFinalAssistantMessage(...)` line
		//  here is REMOVED — the hoisted binding above is reused by the aborted/
		//  error check below.)
		// Task 10: a completed turn is a liveness signal — stamp it BEFORE any
		// early return so the heartbeat stall clock resets on every real turn.
		goalState.lastActivityAt = Date.now();

		const goalId = goalState.activeGoal.id;
		const hadPendingContinuation = goalState.continuationPending?.goalId === goalId;

		if (!hadPendingContinuation) goalState.activeGoal = incrementGoal(goalState.activeGoal);
		updateGoalUsage(goalState.activeGoal, ctx);

		if (finalAssistant?.stopReason === "aborted" || finalAssistant?.stopReason === "error") {
			if (isRetryableGoalInterruption(finalAssistant)) {
				goalState.goalRecovery = {
					goalId,
					kind: isGoalContextOverflow(finalAssistant) ? "compaction_retry" : "provider_retry",
				};
				cancelContinuationPending();
				setAndPersistGoal(goalState.activeGoal, ctx);
				return;
			}
			clearGoalRecoveryForGoal(goalId);
			pauseGoalAfterAgentEnd(ctx, goalState.activeGoal, finalAssistant);
			return;
		}

		clearGoalRecoveryForGoal(goalId);

		if (goalState.activeGoal.tokenBudget !== undefined && goalState.activeGoal.tokensUsed >= goalState.activeGoal.tokenBudget) {
			cancelContinuationPending();
			goalState.activeGoal = transitionGoal(goalState.activeGoal, "budget_limited");
			setAndPersistGoal(goalState.activeGoal, ctx);
			ctx.ui.notify(`Goal token budget reached: ${formatBudget(goalState.activeGoal)}`, "warning");
			return;
		}

		setAndPersistGoal(goalState.activeGoal, ctx);

		if (hadPendingContinuation) {
			if (hasPendingMessages(ctx)) return;
			if (goalState.continuationPending?.goalId === goalId) goalState.continuationPending = undefined;
		}

		const currentGoal = goalState.activeGoal;
		if (!currentGoal || currentGoal.id !== goalId || currentGoal.status !== "active") return;
		if (hasPendingMessages(ctx)) return;

		// Phase-2 hardening (Task 9): classify this iteration before continuing.
		// toolRanThisTurn was set by tool_execution_end if a tool ran this turn;
		// consume + clear it here so toollessStreak truly counts *consecutive*
		// toolless turns (the fix for the off-by-one that previously tripped the
		// stuck threshold on the first legitimate narration turn after a tool).
		const assistantText = finalAssistant?.content?.map((c) => c.text ?? "").join(" ") ?? "";
		const toolRanThisTurn = goalState.toolRanThisTurn;
		if (toolRanThisTurn) {
			goalState.toollessStreak = 0;
			goalState.toolRanThisTurn = false;
		} else {
			goalState.toollessStreak += 1;
		}
		// Phase-2 hardening (Task 10): nudge cap. 3 consecutive no-tool turns means
		// the agent is narrating without making inspectable progress; pause rather
		// than spin the model. Derived from the same per-turn flag the stuck
		// classifier consumes (Task 9) so a tool-bearing turn resets both signals.
		// Checked BEFORE the stuck classifier so a pure narration stall stops here.
		goalState.nudgeCount = accountTurnForNudges(toolRanThisTurn ? 1 : 0, goalState.nudgeCount);
		if (goalState.nudgeCount >= HEARTBEAT_MAX_NUDGES) {
			pauseGoalAfterAgentEnd(
				ctx,
				currentGoal,
				finalAssistant,
				"3 consecutive no-tool turns (nudge cap). Run /goal resume to continue.",
			);
			return;
		}
		const print = textFingerprint(assistantText);
		goalState.recentPrints = pushCapped(goalState.recentPrints, print, REPETITION.printWindow);
		goalState.recentTexts = pushCapped(goalState.recentTexts, assistantText.slice(0, 1000), REPETITION.textWindow);
		const reason = detectLoopStuck({
			assistantText,
			recentPrints: goalState.recentPrints,
			previousText: goalState.recentTexts[goalState.recentTexts.length - 2],
			recentToolResults: goalState.recentToolResults,
			toollessStreak: goalState.toollessStreak,
		});

		if (reason) {
			goalState.consecutiveStuck += 1;
			if (goalState.stuckStartedAt === undefined) goalState.stuckStartedAt = Date.now();
			if (goalState.consecutiveStuck >= REPETITION.maxInterventions) {
				// 5-stuck stop: the rotating interventions are not breaking the loop.
				pauseGoalAfterAgentEnd(
					ctx,
					currentGoal,
					finalAssistant,
					`Goal paused: stuck for ${goalState.consecutiveStuck} iterations (${reason}). Run /goal resume to continue.`,
				);
				return;
			}
			if (shouldPauseAfterBackoff(Date.now() - goalState.stuckStartedAt, goalState.toollessStreak)) {
				// 5-min backoff cap or 3-idle-iteration cap reached.
				pauseGoalAfterAgentEnd(
					ctx,
					currentGoal,
					finalAssistant,
					`Goal paused: backoff cap reached (${reason}). Run /goal resume to continue.`,
				);
				return;
			}
			// Swap the normal continuation for the rotating intervention directive.
			await sendPrompt(pi, ctx, loopInterventionDirective(goalState.consecutiveStuck, reason, goalState.recentTexts));
			return;
		}

		// Not stuck — reset the streak, then continue normally.
		goalState.consecutiveStuck = 0;
		goalState.stuckStartedAt = undefined;
		await sendContinuationPrompt(pi, ctx, currentGoal);
	});	// Heartbeat supervision seam (Task 8). syncHeartbeatTimer's `shouldRun` now
	// includes isLoopActive(), so the heartbeat supervises a goal XOR a loop. But
	// syncHeartbeatTimer is only invoked from updateStatus (goal-driven) — a
	// loop-only session never hits updateStatus, so the heartbeat would never
	// start/stop for a loop. Publish a re-evaluate hook on globalThis (mirroring
	// the __piGoalActive pattern) so the loop's start/stop transitions can arm/
	// disarm the heartbeat WITHOUT a goal↔loop import cycle. Defensive `?.()` —
	// degraded (no heartbeat) if goal() was never registered.
	(globalThis as Record<string, unknown>).__piKickHeartbeat = syncHeartbeatTimer;
}

