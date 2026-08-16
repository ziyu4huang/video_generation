/**
 * lifecycle.ts — the goal state machine's transitions: start, pause, resume,
 * clear, edit, show, plus the two agent_end-driven adjustments.
 *
 * Extracted from goal.ts (spec 1a). These are the bodies behind the `/goal`
 * subcommands; the command REGISTRATION (parsing args, dispatching to these)
 * stays in goal.ts, because that is the wiring the entry point exists to do.
 *
 * Imports down the graph only — internals, status, prompting — never back into
 * goal.ts. `goal-complete-tool.ts` imports `resumeGoal` from here (the quota
 * retry path re-enters an audited goal); nothing here imports the tool.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ActiveGoal, GoalAuditOptions } from "./format.js";
import { formatBudget } from "./format.js";
import {
	createGoal,
	editedGoalStatus,
	goalState,
	normalizeGoalForBudget,
	transitionGoal,
} from "./state.js";
import { clearPersistedGoal, loadReviewerEntries } from "./persistence.js";
import { goalSummary } from "./prompts.js";
import { validateObjective } from "./commands.js";
import { isLoopActive } from "../loop/loop.js";
import { cancelQuotaRetry } from "./quota-retry.js";
import { clearList, goalToListItem } from "./list.js";
import type { AssistantMessageLike } from "./overflow.js";
import type { StatusContext } from "./context.js";
import {
	abortCurrentTurn,
	blockStaleGoalToolCalls,
	cancelContinuationPending,
	clearContinuationTracking,
	clearGoalRecovery,
	clearStaleGoalToolCallBlock,
	currentTokenTotal,
	resetHardeningCounters,
	truncateNotification,
} from "./internals.js";
import { clearActiveGoal, setAndPersistGoal, updateStatus } from "./status.js";
import { sendGoalPrompt, sendObjectiveUpdatedPrompt, sendResumePrompt } from "./prompting.js";

// ─── Goal management ──────────────────────────────────────────────────────────

export async function startGoal(
	objective: string,
	tokenBudget: number | undefined,
	pi: ExtensionAPI,
	ctx: StatusContext,
	audit?: GoalAuditOptions,
) {
	if (isLoopActive()) {
		ctx.ui.notify("A loop is active. Run /loop stop before starting a goal.", "warning");
		return;
	}
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
	goalState.activeGoal = createGoal(objective, tokenBudget, currentTokenTotal(ctx), audit);
	setAndPersistGoal(goalState.activeGoal, ctx);
	ctx.ui.notify(existingGoal ? `Goal replaced: ${objective}` : `Goal started: ${objective}`, "info");
	await sendGoalPrompt(pi, ctx, goalState.activeGoal);
}

/**
 * `/goal audit` toggle: flip auditEnabled on the active goal. Lets a user opt a
 * goal into (or out of) the completion auditor after it has started. No-op
 * notify when there is no active goal.
 */
export function toggleGoalAudit(ctx: StatusContext) {
	if (!goalState.activeGoal) {
		ctx.ui.notify("No active goal.", "info");
		return;
	}
	const next = !goalState.activeGoal.auditEnabled;
	goalState.activeGoal = { ...goalState.activeGoal, auditEnabled: next, updatedAt: Date.now() };
	setAndPersistGoal(goalState.activeGoal, ctx);
	ctx.ui.notify(`Completion audit ${next ? "enabled" : "disabled"} for goal: ${goalState.activeGoal.text}`, "info");
}

export function pauseGoal(ctx: StatusContext) {
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
	setAndPersistGoal(goalState.activeGoal, ctx);
	ctx.ui.notify(`Goal paused: ${goalState.activeGoal.text}`, "info");
}

export async function resumeGoal(pi: ExtensionAPI, ctx: StatusContext) {
	cancelQuotaRetry(); // quota-retry: a manual resume cancels the scheduled auto-resume
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
	setAndPersistGoal(goalState.activeGoal, ctx);
	if (goalState.activeGoal.status !== "active") {
		ctx.ui.notify(`Goal token budget is still reached: ${formatBudget(goalState.activeGoal)}`, "warning");
		return;
	}
	ctx.ui.notify(`Goal resumed: ${goalState.activeGoal.text}`, "info");
	await sendResumePrompt(pi, ctx, goalState.activeGoal);
}

export function clearGoal(ctx: StatusContext) {
	if (!goalState.activeGoal) {
		ctx.ui.notify("No active goal.", "info");
		cancelContinuationPending();
		clearGoalRecovery();
		clearStaleGoalToolCallBlock();
		// /goal clear is a queue-lifecycle boundary: drop the in-memory queue +
		// position so a later bare /goal "x" shows no phantom ☰ …/2 suffix and
		// the widget position doesn't inflate across sessions.
		goalState.list = [];
		goalState.headAdvances = 0;
		clearPersistedGoal(goalState.extensionApi as ExtensionAPI);
		goalState.overlay?.update(undefined);
		return;
	}

	const stoppedGoal = goalState.activeGoal.text;
	clearActiveGoal(ctx);
	ctx.ui.notify(`Goal cleared: ${stoppedGoal}`, "warning");
}

export async function editGoal(
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
	setAndPersistGoal(goalState.activeGoal, ctx);
	ctx.ui.notify(`Goal updated: ${objective}`, "info");
	if (goalState.activeGoal.status === "active") {
		clearStaleGoalToolCallBlock();
		await sendObjectiveUpdatedPrompt(pi, ctx, goalState.activeGoal);
	}
}

export function showGoal(ctx: StatusContext) {
	if (!goalState.activeGoal) {
		ctx.ui.notify("Usage: /goal <objective>\nNo goal is currently set.", "info");
		goalState.overlay?.update(undefined);
		return;
	}
	updateGoalUsage(goalState.activeGoal, ctx);
	setAndPersistGoal(goalState.activeGoal, ctx);

	// Read the last reviewer entry (if any) to surface what the Reviewer last did.
	const reviewerEntries = loadReviewerEntries(ctx.sessionManager);
	const lastEntry = reviewerEntries.length > 0 ? reviewerEntries[reviewerEntries.length - 1] : undefined;
	const lastReview =
		lastEntry && lastEntry.type === "reviewer_fired"
			? {
					cascadeStep: lastEntry.cascadeStep,
					enqueued: lastEntry.enqueued,
					proposed: lastEntry.proposed,
			  }
			: undefined;

	ctx.ui.notify(goalSummary(goalState.activeGoal, lastReview), "info");
}

export function pauseGoalAfterAgentEnd(
	ctx: StatusContext,
	goal: ActiveGoal,
	assistant: AssistantMessageLike | undefined,
	reasonOverride?: string,
) {
	cancelContinuationPending();
	blockStaleGoalToolCalls();
	abortCurrentTurn(ctx);
	goalState.activeGoal = transitionGoal(goal, "paused");
	setAndPersistGoal(goalState.activeGoal, ctx);

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

export function updateGoalUsage(goal: ActiveGoal, ctx: StatusContext) {
	goal.tokensUsed = Math.max(0, currentTokenTotal(ctx) - goal.baselineTokens);
	goal.timeUsedSeconds = Math.max(0, Math.floor((Date.now() - goal.startedAt) / 1000));
	goal.updatedAt = Date.now();
}