/**
 * goal tool + /goal command — ported from @narumitw/pi-goal v0.11.0.
 *
 * Adaptations for power-tool embedding:
 *   - Overflow / interruption classification (isContextOverflow, the local
 *     AssistantMessageLike + Usage types, etc.) live in ./overflow.ts — a
 *     pure module with ZERO @earendil-works/* imports. Inlined originally from
 *     @earendil-works/pi-ai; no external dep needed.
 *   - Import from "fs" / "path" / "crypto" (no "node:" prefix — Bun convention).
 *   - Removed import process from "node:process" (process is global in Bun).
 *
 * State machine:
 *   active ← → paused
 *   active → budget_limited (tokensUsed >= tokenBudget)
 *   active → complete (via goal_complete tool)
 *   paused → active (via /goal resume)
 *   budget_limited → active (via /goal resume, if budget allows)
 *   any → cleared (via /goal clear)
 */

import { randomUUID } from "crypto";
import { defineTool, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getPlanSummary, isPlanIncomplete } from "../plan/coordinator.js";
import { GoalOverlay, type GoalOverlayLike } from "./overlay.js";
import { formatBudget, type ActiveGoal } from "./format.js";
import {
	createGoal,
	editedGoalStatus,
	goalState,
	incrementGoal,
	normalizeGoalForBudget,
	transitionGoal,
	type GoalCompleteDetails,
} from "./state.js";
import { clearPersistedGoal, loadGoalFromSession, persistGoal } from "./persistence.js";
import {
	findFinalAssistantMessage,
	isContradictoryCompletionSummary,
	isGoalContextOverflow,
	isRetryableGoalInterruption,
	type AssistantMessageLike,
} from "./overflow.js";
import { backoffMs, shouldPauseAfterBackoff } from "./backoff.js";
import {
	detectLoopStuck,
	loopInterventionDirective,
	textFingerprint,
	pushCapped,
	REPETITION,
} from "./repetition.js";
import {
	completeGoalArguments,
	parseCommand,
	parseTokenBudget,
	validateObjective,
	type CommandResult,
} from "./commands.js";
import {
	buildContinuePrompt,
	buildGoalPrompt,
	buildGoalSystemPrompt,
	buildObjectiveUpdatedPrompt,
	buildResumePrompt,
	goalSummary,
	CONTINUATION_MARKER_PREFIX,
} from "./prompts.js";

// Re-export formatters + types for tests and downstream consumers.
export { formatStatus, formatGoalMetric, formatDuration, formatTokenCount, type ActiveGoal } from "./format.js";
// Re-export overflow helpers so the public import path via goal.js is preserved.
export { findFinalAssistantMessage, isContradictoryCompletionSummary, isRetryableGoalInterruption } from "./overflow.js";
// Re-export /goal command-parsing helpers so the public import path via goal.js
// is preserved (goal.test.ts imports these from ../goal.js).
export { parseCommand, parseTokenBudget, validateObjective, completeGoalArguments } from "./commands.js";
// Re-export the goal-mode system-prompt builder so the public import path via
// goal.js is preserved (goal.test.ts imports buildGoalSystemPrompt from ../goal.js).
export { buildGoalSystemPrompt } from "./prompts.js";

// ─── Status context (UI-facing; stays in goal.ts) ─────────────────────────────

export interface StatusContext {
	cwd: string;
	ui: ExtensionUIContext;
	isIdle?: () => boolean;
	hasPendingMessages?: () => boolean;
	abort?: () => void;
	sessionManager?: unknown;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_CANCELLED_CONTINUATION_PROMPTS = 20;

// ─── Module state ─────────────────────────────────────────────────────────────
// Session-scoped runtime state lives in the `goalState` container (./state.js)
// so it can be reset from tests via `__resetGoalState()`. `goalState.extensionApi` and
// `goalState.latestCtx` are typed `unknown` there to keep state.ts free of
// @earendil-works/* imports; they are narrowed with localized casts below.
let goalOverlay: GoalOverlayLike | undefined;
const STATUS_REFRESH_INTERVAL_MS = 1_000;

// ─── Coordination seam (Plan A: goal ⇄ plan coordinator mutual-exclusion) ──

/**
 * Whether a /goal is currently in the "active" (driving) state.
 *
 * Exported so the plan coordinator can query it (dynamic import + fallback to
 * false) and yield its own before_agent_start injection + agent_end
 * auto-continue to the goal, which owns iteration counting, token budget, and
 * recovery. Returns FALSE for paused / budget_limited / complete / no-goal —
 * so the plan coordinator may resume its own continuation when the goal is NOT
 * actively driving (e.g. user paused the goal).
 */
export function isGoalActive(): boolean {
	return goalState.activeGoal?.status === "active";
}

// ─── Tool definition ──────────────────────────────────────────────────────────

const goalCompleteTool = defineTool({
	name: "goal_complete",
	label: "Goal Complete",
	description:
		"Mark the active /goal as complete after all required work is done and verified. Do not use for partial progress, blockers, failing, or unverified work.",
	parameters: Type.Object({
		summary: Type.String({
			description:
				"State what was completed and what evidence verified it. Do not use this tool to report partial progress, blockers, failures, or remaining work.",
		}),
	}),
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: (msg: any) => void, ctx: any) {
		const completedGoal = goalState.activeGoal;
		const goal = completedGoal?.text ?? "unknown goal";
		const summary = (params.summary as string).trim();

		if (!completedGoal) {
			const rejection = "Goal completion rejected: no active goal.";
			ctx.ui.notify(rejection, "warning");
			return {
				content: [{ type: "text", text: rejection }],
				details: { goal, summary } satisfies GoalCompleteDetails,
			};
		}

		const rejectionReason = !summary
			? "summary is empty"
			: isContradictoryCompletionSummary(summary)
				? "summary says the goal is not complete"
				: undefined;
		if (rejectionReason) {
			updateGoalUsage(completedGoal, ctx);
			persistGoal(goalState.extensionApi as ExtensionAPI, completedGoal);
			updateStatus(ctx, completedGoal);
			const rejection = `Goal completion rejected: ${rejectionReason}.`;
			ctx.ui.notify(rejection, "warning");
			return {
				content: [{ type: "text", text: rejection }],
				details: { goal, summary } satisfies GoalCompleteDetails,
			};
		}

		// Plan A coordination seam: block goal_complete while the plan coordinator
		// reports open phases. The goal's own summary audit can't see plan state; this
		// closes the gap. Release valve: close the plan (→ __piPlanIncomplete returns
		// false). Best-effort: if no plan coordinator is loaded or it errors, the
		// gate is a no-op (goal_complete proceeds).
		const planningReason = planningGateBlocking(ctx.cwd);
		if (planningReason) {
			updateGoalUsage(completedGoal, ctx);
			persistGoal(goalState.extensionApi as ExtensionAPI, completedGoal);
			updateStatus(ctx, completedGoal);
			const rejection =
				`Goal completion rejected: ${planningReason}. ` +
				"Finish the remaining plan phases, or close the plan, then call goal_complete again.";
			ctx.ui.notify(rejection, "warning");
			return {
				content: [{ type: "text", text: rejection }],
				details: { goal, summary } satisfies GoalCompleteDetails,
			};
		}

		if (completedGoal) {
			goalState.activeGoal = transitionGoal(completedGoal, "complete");
			updateGoalUsage(goalState.activeGoal, ctx);
			persistGoal(goalState.extensionApi as ExtensionAPI, goalState.activeGoal);
		}

		clearActiveGoal(ctx);
		showCompletionStatus(ctx, goal);
		ctx.ui.notify(`Goal complete: ${goal}`, "info");

		return {
			content: [{ type: "text", text: `Goal complete: ${summary}` }],
			details: { goal, summary } satisfies GoalCompleteDetails,
			terminate: true,
		};
	},
});

// ─── Public entry point ───────────────────────────────────────────────────────

export default function goal(pi: ExtensionAPI, overlay: GoalOverlayLike = new GoalOverlay()) {
	goalState.extensionApi = pi;
	goalOverlay = overlay;
	pi.registerTool(goalCompleteTool);

	pi.registerCommand("goal", {
		description: "Run a goal to completion: /goal [--tokens 100k] <goal_to_complete>",
		getArgumentCompletions: completeGoalArguments,
		handler: async (args: string, ctx: StatusContext) => {
			const result = parseCommand(args);
			if (typeof result === "string") {
				ctx.ui.notify(result, "warning");
				return;
			}

			switch (result.kind) {
				case "show":
					showGoal(ctx);
					return;
				case "pause":
					pauseGoal(ctx);
					return;
				case "resume":
					await resumeGoal(pi, ctx);
					return;
				case "clear":
					clearGoal(ctx);
					return;
				case "edit":
					await editGoal(result.objective ?? "", result.tokenBudget, pi, ctx);
					return;
				case "start":
					await startGoal(result.objective ?? "", result.tokenBudget, pi, ctx);
					return;
			}
		},
	});

	pi.on("session_start", (_event: unknown, ctx: StatusContext) => {
		// Reset the overlay for the fresh session: rebind the UI ctx and drop any
		// stale completion flash left over from the previous session.
		goalOverlay?.setUICtx(ctx.ui);
		stopStatusRefreshTimer();
		clearContinuationTracking();
		clearGoalRecovery();
		clearStaleGoalToolCallBlock();
		goalState.activeGoal = loadGoalFromSession(ctx.sessionManager);
		if (goalState.activeGoal) updateStatus(ctx, goalState.activeGoal);
		else goalOverlay?.update(undefined);
	});

	pi.on("session_shutdown", (_event: unknown, _ctx: StatusContext) => {
		if (goalState.activeGoal) persistGoal(goalState.extensionApi as ExtensionAPI, goalState.activeGoal);
		clearContinuationTracking();
		clearGoalRecovery();
		clearStaleGoalToolCallBlock();
		stopStatusRefreshTimer();
		goalOverlay?.dispose();
	});

	pi.on("session_before_compact", (_event: unknown, ctx: StatusContext) => {
		if (!goalState.activeGoal || goalState.activeGoal.status !== "active") return;
		updateGoalUsage(goalState.activeGoal, ctx);
		cancelContinuationPending();
		persistGoal(goalState.extensionApi as ExtensionAPI, goalState.activeGoal);
		updateStatus(ctx, goalState.activeGoal);
	});

	pi.on("session_compact", async (event: unknown, ctx: StatusContext) => {
		if (!goalState.activeGoal || goalState.activeGoal.status !== "active") {
			clearGoalRecovery();
			return;
		}

		const restoredGoal = loadGoalFromSession(ctx.sessionManager);
		if (restoredGoal?.id === goalState.activeGoal.id) goalState.activeGoal = restoredGoal;
		updateGoalUsage(goalState.activeGoal, ctx);
		persistGoal(goalState.extensionApi as ExtensionAPI, goalState.activeGoal);
		updateStatus(ctx, goalState.activeGoal);

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
		goalState.toollessStreak = 0;
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
		if (!goalState.activeGoal || goalState.activeGoal.status !== "active") return;

		const goalId = goalState.activeGoal.id;
		const hadPendingContinuation = goalState.continuationPending?.goalId === goalId;
		const finalAssistant = findFinalAssistantMessage(event.messages ?? []);

		if (!hadPendingContinuation) goalState.activeGoal = incrementGoal(goalState.activeGoal);
		updateGoalUsage(goalState.activeGoal, ctx);

		if (finalAssistant?.stopReason === "aborted" || finalAssistant?.stopReason === "error") {
			if (isRetryableGoalInterruption(finalAssistant)) {
				goalState.goalRecovery = {
					goalId,
					kind: isGoalContextOverflow(finalAssistant) ? "compaction_retry" : "provider_retry",
				};
				cancelContinuationPending();
				persistGoal(goalState.extensionApi as ExtensionAPI, goalState.activeGoal);
				updateStatus(ctx, goalState.activeGoal);
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
			persistGoal(goalState.extensionApi as ExtensionAPI, goalState.activeGoal);
			updateStatus(ctx, goalState.activeGoal);
			ctx.ui.notify(`Goal token budget reached: ${formatBudget(goalState.activeGoal)}`, "warning");
			return;
		}

		persistGoal(goalState.extensionApi as ExtensionAPI, goalState.activeGoal);
		updateStatus(ctx, goalState.activeGoal);

		if (hadPendingContinuation) {
			if (hasPendingMessages(ctx)) return;
			if (goalState.continuationPending?.goalId === goalId) goalState.continuationPending = undefined;
		}

		const currentGoal = goalState.activeGoal;
		if (!currentGoal || currentGoal.id !== goalId || currentGoal.status !== "active") return;
		if (hasPendingMessages(ctx)) return;

		// Phase-2 hardening (Task 9): classify this iteration before continuing.
		// toollessStreak is reset to 0 by tool_execution_end when a tool ran this
		// turn; otherwise each agent_end bumps it (narration-only loop detection).
		const assistantText = finalAssistant?.content?.map((c) => c.text ?? "").join(" ") ?? "";
		goalState.toollessStreak += 1;
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

		// Not stuck — reset the streak, apply a brief backoff, then continue normally.
		goalState.consecutiveStuck = 0;
		goalState.stuckStartedAt = undefined;
		const wait = backoffMs(0);
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		await sendContinuationPrompt(pi, ctx, currentGoal);
	});
}

// ─── Goal management ──────────────────────────────────────────────────────────

async function startGoal(
	objective: string,
	tokenBudget: number | undefined,
	pi: ExtensionAPI,
	ctx: StatusContext,
) {
	const validationError = validateObjective(objective);
	if (validationError) {
		ctx.ui.notify(validationError, "warning");
		return;
	}

	const existingGoal = goalState.activeGoal?.status !== "complete" ? goalState.activeGoal : undefined;
	if (existingGoal) {
		const shouldReplace = await ctx.ui.confirm(
			"Replace goal?",
			`Current goal: ${existingGoal.text}\n\nNew goal: ${objective}`,
		);
		if (!shouldReplace) {
			ctx.ui.notify(`Goal kept: ${existingGoal.text}`, "info");
			return;
		}
	}

	cancelContinuationPending();
	clearGoalRecovery();
	clearStaleGoalToolCallBlock();
	resetHardeningCounters();
	goalState.activeGoal = createGoal(objective, tokenBudget, currentTokenTotal(ctx));
	persistGoal(goalState.extensionApi as ExtensionAPI, goalState.activeGoal);
	updateStatus(ctx, goalState.activeGoal);
	ctx.ui.notify(existingGoal ? `Goal replaced: ${objective}` : `Goal started: ${objective}`, "info");
	await sendGoalPrompt(pi, ctx, goalState.activeGoal);
}

function pauseGoal(ctx: StatusContext) {
	if (!goalState.activeGoal) {
		ctx.ui.notify("No active goal.", "info");
		return;
	}
	if (goalState.activeGoal.status !== "active") {
		ctx.ui.notify(`Goal is ${goalState.activeGoal.status}; only active goals can be paused.`, "warning");
		return;
	}
	cancelContinuationPending();
	blockStaleGoalToolCalls();
	abortCurrentTurn(ctx);
	goalState.activeGoal = transitionGoal(goalState.activeGoal, "paused");
	persistGoal(goalState.extensionApi as ExtensionAPI, goalState.activeGoal);
	updateStatus(ctx, goalState.activeGoal);
	ctx.ui.notify(`Goal paused: ${goalState.activeGoal.text}`, "info");
}

async function resumeGoal(pi: ExtensionAPI, ctx: StatusContext) {
	if (!goalState.activeGoal) {
		ctx.ui.notify("No active goal.", "info");
		return;
	}
	if (goalState.activeGoal.status !== "paused" && goalState.activeGoal.status !== "budget_limited") {
		ctx.ui.notify(`Goal is ${goalState.activeGoal.status}; only paused or budget-limited goals can be resumed.`, "warning");
		return;
	}
	clearGoalRecovery();
	clearStaleGoalToolCallBlock();
	goalState.activeGoal = transitionGoal(goalState.activeGoal, "active");
	persistGoal(goalState.extensionApi as ExtensionAPI, goalState.activeGoal);
	updateStatus(ctx, goalState.activeGoal);
	if (goalState.activeGoal.status !== "active") {
		ctx.ui.notify(`Goal token budget is still reached: ${formatBudget(goalState.activeGoal)}`, "warning");
		return;
	}
	ctx.ui.notify(`Goal resumed: ${goalState.activeGoal.text}`, "info");
	await sendResumePrompt(pi, ctx, goalState.activeGoal);
}

function clearGoal(ctx: StatusContext) {
	if (!goalState.activeGoal) {
		ctx.ui.notify("No active goal.", "info");
		cancelContinuationPending();
		clearGoalRecovery();
		clearStaleGoalToolCallBlock();
		clearPersistedGoal(goalState.extensionApi as ExtensionAPI, ctx.cwd);
		goalOverlay?.update(undefined);
		return;
	}

	const stoppedGoal = goalState.activeGoal.text;
	clearActiveGoal(ctx);
	ctx.ui.notify(`Goal cleared: ${stoppedGoal}`, "warning");
}

async function editGoal(
	objective: string,
	tokenBudget: number | undefined,
	pi: ExtensionAPI,
	ctx: StatusContext,
) {
	const validationError = validateObjective(objective);
	if (validationError) {
		ctx.ui.notify(validationError, "warning");
		return;
	}
	if (!goalState.activeGoal) {
		ctx.ui.notify("No active goal. Use /goal <objective> to start one.", "warning");
		return;
	}

	updateGoalUsage(goalState.activeGoal, ctx);
	cancelContinuationPending();
	clearGoalRecovery();
	goalState.activeGoal = normalizeGoalForBudget({
		...goalState.activeGoal,
		text: objective,
		status: editedGoalStatus(goalState.activeGoal.status),
		tokenBudget: tokenBudget ?? goalState.activeGoal.tokenBudget,
		updatedAt: Date.now(),
	});
	persistGoal(goalState.extensionApi as ExtensionAPI, goalState.activeGoal);
	updateStatus(ctx, goalState.activeGoal);
	ctx.ui.notify(`Goal updated: ${objective}`, "info");
	if (goalState.activeGoal.status === "active") {
		clearStaleGoalToolCallBlock();
		await sendObjectiveUpdatedPrompt(pi, ctx, goalState.activeGoal);
	}
}

function showGoal(ctx: StatusContext) {
	if (!goalState.activeGoal) {
		ctx.ui.notify("Usage: /goal <objective>\nNo goal is currently set.", "info");
		goalOverlay?.update(undefined);
		return;
	}
	updateGoalUsage(goalState.activeGoal, ctx);
	persistGoal(goalState.extensionApi as ExtensionAPI, goalState.activeGoal);
	updateStatus(ctx, goalState.activeGoal);
	ctx.ui.notify(goalSummary(goalState.activeGoal), "info");
}

function pauseGoalAfterAgentEnd(
	ctx: StatusContext,
	goal: ActiveGoal,
	assistant: AssistantMessageLike | undefined,
	reasonOverride?: string,
) {
	cancelContinuationPending();
	blockStaleGoalToolCalls();
	abortCurrentTurn(ctx);
	goalState.activeGoal = transitionGoal(goal, "paused");
	persistGoal(goalState.extensionApi as ExtensionAPI, goalState.activeGoal);
	updateStatus(ctx, goalState.activeGoal);

	// When a caller supplies a reason override (e.g. the stuck-repetition /
	// backoff-cap paths in agent_end), it IS the full notify message — the
	// default "paused after interruption/agent error" wording is semantically
	// wrong for those stops. `assistant` is unused on that path. Existing 3-arg
	// callers keep the legacy message (and pass a narrowed non-undefined assistant).
	if (reasonOverride) {
		ctx.ui.notify(reasonOverride, "warning");
		return;
	}
	const reason = assistant?.stopReason === "aborted" ? "interruption" : "agent error";
	const details = assistant?.errorMessage ? ` (${truncateNotification(assistant.errorMessage)})` : "";
	ctx.ui.notify(`Goal paused after ${reason}${details}. Run /goal resume to continue.`, "warning");
}

function updateGoalUsage(goal: ActiveGoal, ctx: StatusContext) {
	goal.tokensUsed = Math.max(0, currentTokenTotal(ctx) - goal.baselineTokens);
	goal.timeUsedSeconds = Math.max(0, Math.floor((Date.now() - goal.startedAt) / 1000));
	goal.updatedAt = Date.now();
}

/**
 * Keep the active-goal overlay ticking. Without this, `timeUsedSeconds` is a
 * frozen snapshot (only recomputed at agent_end / compact), so a long active
 * turn shows "goal active · 0s · iter 0" for its whole duration. The tick
 * recomputes elapsed time (and token usage) live and pokes the overlay, whose
 * `refresh()` re-renders the widget. Not persisted — persistence stays at
 * agent_end / compact to avoid flooding the session log.
 */
function tickActiveGoalStatus() {
	if (!goalState.activeGoal || goalState.activeGoal.status !== "active" || !goalState.latestCtx) return;
	goalState.activeGoal.timeUsedSeconds = Math.max(0, Math.floor((Date.now() - goalState.activeGoal.startedAt) / 1000));
	goalState.activeGoal.tokensUsed = Math.max(0, currentTokenTotal(goalState.latestCtx as StatusContext) - goalState.activeGoal.baselineTokens);
	goalState.activeGoal.updatedAt = Date.now();
	goalOverlay?.update(goalState.activeGoal);
}

function stopStatusRefreshTimer() {
	if (!goalState.statusRefreshTimer) return;
	clearInterval(goalState.statusRefreshTimer);
	goalState.statusRefreshTimer = undefined;
}

/** Start a 1s refresh interval only while a goal is active; stop otherwise. */
function syncStatusRefreshTimer() {
	const shouldRun = goalState.activeGoal?.status === "active";
	if (shouldRun && !goalState.statusRefreshTimer) {
		goalState.statusRefreshTimer = setInterval(tickActiveGoalStatus, STATUS_REFRESH_INTERVAL_MS);
		// Never keep the process alive just for the status ticker (tests, -p batch).
		goalState.statusRefreshTimer?.unref?.();
	} else if (!shouldRun && goalState.statusRefreshTimer) {
		stopStatusRefreshTimer();
	}
}

// ─── Argument completions & parsing ─────────────────────────────────────────
// Moved to ./commands.ts (pure module, zero @earendil-works/* imports).
// Re-exported above for the legacy ../goal.js public import path.

// ─── Prompt sending ───────────────────────────────────────────────────────────

async function sendGoalPrompt(pi: ExtensionAPI, ctx: StatusContext, goal: ActiveGoal) {
	return sendPrompt(pi, ctx, buildGoalPrompt(goal));
}

async function sendObjectiveUpdatedPrompt(pi: ExtensionAPI, ctx: StatusContext, goal: ActiveGoal) {
	return sendPrompt(pi, ctx, buildObjectiveUpdatedPrompt(goal));
}

async function sendResumePrompt(pi: ExtensionAPI, ctx: StatusContext, goal: ActiveGoal) {
	return sendPrompt(pi, ctx, buildResumePrompt(goal));
}

async function sendContinuationPrompt(pi: ExtensionAPI, ctx: StatusContext, goal: ActiveGoal) {
	if (goalState.continuationPending?.goalId === goal.id) return false;
	if (hasPendingMessages(ctx)) return false;

	const marker = continuationMarker(goal);
	const prompt = buildContinuePrompt(goal, marker, planProgressLineFromPeer());
	goalState.continuationPending = { goalId: goal.id, iteration: goal.iteration, marker, prompt };
	const sent = await sendPrompt(pi, ctx, prompt);
	if (!sent && goalState.continuationPending?.marker === marker) goalState.continuationPending = undefined;
	return sent;
}

async function sendPrompt(pi: ExtensionAPI, ctx: StatusContext, prompt: string) {
	try {
		const sent = ctx.isIdle?.()
			? (pi.sendUserMessage(prompt) as void | Promise<void>)
			: (pi.sendUserMessage(prompt, { deliverAs: "followUp" }) as void | Promise<void>);
		await sent;
		return true;
	} catch (error) {
		ctx.ui.notify(`Goal prompt failed: ${formatError(error)}`, "error");
		return false;
	}
}

// ─── Status helpers ───────────────────────────────────────────────────────────
// The GoalOverlay widget is the single UI surface for goal state. These are
// thin delegates so command handlers / lifecycle hooks / agent_end read cleanly
// while updateStatus keeps its (_ctx, goal) call sites unchanged.

function updateStatus(ctx: StatusContext, _goal: ActiveGoal) {
	goalState.latestCtx = ctx;
	goalOverlay?.update(goalState.activeGoal);
	syncStatusRefreshTimer();
}

// ─── Context helpers ──────────────────────────────────────────────────────────

function hasPendingMessages(ctx: StatusContext) {
	return ctx.hasPendingMessages?.() ?? false;
}

function abortCurrentTurn(ctx: StatusContext) {
	try {
		ctx.abort?.();
	} catch {
		// Best effort: stale goal guards still prevent follow-on tool calls.
	}
}

function blockStaleGoalToolCalls() {
	goalState.staleGoalToolCallsBlocked = true;
}

function clearStaleGoalToolCallBlock() {
	goalState.staleGoalToolCallsBlocked = false;
}

/** Reset the Phase-2 anti-repetition / backoff rolling counters (Task 9). */
function resetHardeningCounters() {
	goalState.consecutiveStuck = 0;
	goalState.stuckStartedAt = undefined;
	goalState.recentPrints = [];
	goalState.recentTexts = [];
	goalState.recentToolResults = [];
	goalState.toollessStreak = 0;
}

/** Best-effort stringification of a tool result for fingerprinting. Never throws. */
function safeStringify(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function clearGoalRecovery() {
	goalState.goalRecovery = undefined;
}

function clearGoalRecoveryForGoal(goalId: string) {
	if (goalState.goalRecovery?.goalId === goalId) goalState.goalRecovery = undefined;
}

function isPiOwnedCompactionRetry(event: unknown, goalId: string) {
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
 * publishes `__piPlanIncomplete` on globalThis ONLY for wayfind — goal.ts calls
 * it directly here.
 */
export function planningGateBlocking(cwd: string): string | undefined {
	return isPlanIncomplete(cwd) ? "the plan still has incomplete phases" : undefined;
}

/**
 * Fusion: direct internal call to the in-package plan coordinator (ticket 03:
 * self-consume = internal-call, NOT globalThis). Surfaces the active plan's
 * phase progress so a goal-driven agent keeps roadmap visibility. Empty string
 * when goalState.latestCtx is unset or no plan is cached. The coordinator publishes
 * `__piPlanSummary` on globalThis ONLY for wayfind — goal.ts calls it directly.
 */
export function planProgressLineFromPeer(): string {
	const cwd = (goalState.latestCtx as StatusContext | undefined)?.cwd;
	if (!cwd) return "";
	return getPlanSummary(cwd);
}

// ─── Continuation tracking ────────────────────────────────────────────────────

function clearContinuationTracking() {
	goalState.continuationPending = undefined;
	goalState.cancelledContinuationMarkers.clear();
}

function cancelContinuationPending() {
	if (goalState.continuationPending) rememberCancelledContinuationMarker(goalState.continuationPending.marker);
	goalState.continuationPending = undefined;
}

function rememberCancelledContinuationMarker(marker: string) {
	goalState.cancelledContinuationMarkers.add(marker);
	if (goalState.cancelledContinuationMarkers.size <= MAX_CANCELLED_CONTINUATION_PROMPTS) return;
	const oldest = goalState.cancelledContinuationMarkers.values().next().value;
	if (oldest) goalState.cancelledContinuationMarkers.delete(oldest);
}

function consumeCancelledContinuationPrompt(prompt: string) {
	const marker = extractContinuationMarker(prompt);
	return marker ? goalState.cancelledContinuationMarkers.delete(marker) : false;
}

function markContinuationDelivered(prompt: string) {
	const marker = extractContinuationMarker(prompt);
	if (marker && goalState.continuationPending?.marker === marker) goalState.continuationPending = undefined;
}

function continuationMarker(goal: ActiveGoal) {
	return `${goal.id}:${goal.iteration}:${randomUUID()}`;
}

function escapeRegExpText(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CONTINUATION_MARKER_PATTERN = new RegExp(
	`<!--\\s*${escapeRegExpText(CONTINUATION_MARKER_PREFIX)}([^\\s>]+)\\s*-->`,
);

function extractContinuationMarker(prompt: string) {
	return CONTINUATION_MARKER_PATTERN.exec(prompt)?.[1];
}

// ─── XML/text helpers ─────────────────────────────────────────────────────────

function formatError(error: unknown) {
	return truncateNotification(error instanceof Error ? error.message : String(error));
}

function truncateNotification(value: string) {
	return value.length > 160 ? `${value.slice(0, 157)}...` : value;
}

// ─── Token tracking ───────────────────────────────────────────────────────────

function currentTokenTotal(ctx: StatusContext): number {
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

// ─── Persistence ──────────────────────────────────────────────────────────────
// persistGoal / clearPersistedGoal / loadGoalFromSession + the legacy
// pi-goal-state.json live in ./persistence.ts (deps injected: api /
// sessionManager passed as params; no module-state reads) — imported above.

function clearActiveGoal(ctx: StatusContext) {
	cancelContinuationPending();
	clearGoalRecovery();
	clearStaleGoalToolCallBlock();
	goalState.activeGoal = undefined;
	clearPersistedGoal(goalState.extensionApi as ExtensionAPI, ctx.cwd);
	goalOverlay?.update(undefined);
	stopStatusRefreshTimer();
}

// Transient "✓ goal complete" flash (~8s) shown after goal_complete, then the
// overlay hides itself. The flash timer + render live entirely in GoalOverlay.
// The status-refresh interval (goalState.statusRefreshTimer) is a SEPARATE module-level
// timer that ticks the elapsed-time metric while a goal is active; it is
// stopped on session_shutdown / clearActiveGoal / any non-active transition
// (syncStatusRefreshTimer), so it never goes stale across sessions.
function showCompletionStatus(_ctx: StatusContext, objective: string) {
	goalOverlay?.showCompletion(objective);
}

// Clone / isGoal / normalizeGoalForBudget / incrementGoal / transitionGoal /
// editedGoalStatus / createGoal + the goal-owned types live in ./state.ts
// (pure module, zero @earendil-works/* imports) — re-imported above.
// persistGoal / clearPersistedGoal / loadGoalFromSession + the legacy
// pi-goal-state.json live in ./persistence.ts — re-imported above.
