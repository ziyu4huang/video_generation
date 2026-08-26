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
import { getPlanPhases } from "../plan/coordinator.js";
import {
	planApprovalNeeded,
	recordPlanDecision,
	shouldPromptForApproval,
	summarizePhases,
} from "../plan/approval.js";

// ─── Plan approval (ticket 01: ExitPlanMode-shaped gate) ─────────────────────

/** Render + confirm + record one approval decision (the shared dialog body). */
async function runApprovalPrompt(ctx: StatusContext, phases: ReturnType<typeof getPlanPhases>): Promise<boolean> {
	const approved = await ctx.ui.confirm("Approve plan?", summarizePhases(phases));
	recordPlanDecision(ctx.cwd, phases, approved);
	ctx.ui.notify(
		approved
			? `Plan approved (${phases.filter((p) => p.status === "completed").length}/${phases.length} phases done).`
			: "Plan NOT approved — read-only planning: write/edit stay blocked and goal_complete will refuse until /goal approve.",
		approved ? "info" : "warning",
	);
	return approved;
}

/**
 * Prompt plan approval when the active plan needs it (incomplete + unapproved
 * + this contract version not yet prompted). Returns the decision when a
 * prompt fired, undefined when nothing needed one (no plan / complete /
 * already prompted — the once-per-contract-version dedupe lives here).
 *
 * Called from /goal start, /goal resume, and the agent_end re-prompt
 * (contract edited mid-goal) — the interactive seam for the pure approval
 * state machine in ../plan/approval.js.
 */
export async function promptPlanApprovalIfNeeded(ctx: StatusContext): Promise<boolean | undefined> {
	const phases = getPlanPhases(ctx.cwd);
	if (!shouldPromptForApproval(ctx.cwd, phases)) return undefined;
	return runApprovalPrompt(ctx, phases);
}

/**
 * `/goal approve` — the EXPLICIT approval entry. Bypasses the automatic
 * prompt dedupe: a user who denied at /goal start and changed their mind must
 * get the dialog again (promptedContract dedupe guards automatic re-prompts,
 * never a direct command). No-op only when there is nothing to approve
 * (no plan / complete / already approved for this contract).
 */
export async function approvePlan(ctx: StatusContext) {
	const phases = getPlanPhases(ctx.cwd);
	if (phases.length === 0) {
		ctx.ui.notify("No active plan found — nothing to approve.", "info");
		return;
	}
	if (!planApprovalNeeded(ctx.cwd, phases)) {
		ctx.ui.notify("Plan already approved (or complete) — nothing to do.", "info");
		return;
	}
	await runApprovalPrompt(ctx, phases);
}

// ─── Goal management ──────────────────────────────────────────────────────────

export async function startGoal(
	objective: string,
	tokenBudget: number | undefined,
	pi: ExtensionAPI,
	ctx: StatusContext,
	audit?: GoalAuditOptions,
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
	goalState.activeGoal = createGoal(objective, tokenBudget, currentTokenTotal(ctx), audit);
	setAndPersistGoal(goalState.activeGoal, ctx);
	ctx.ui.notify(existingGoal ? `Goal replaced: ${objective}` : `Goal started: ${objective}`, "info");
	// Ticket 01: an active incomplete plan needs user approval before
	// implementation — prompt at goal entry (after createGoal so the
	// read-only gate has an active goal to key on, before the first prompt).
	await promptPlanApprovalIfNeeded(ctx);
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
	// Ticket 01: resume re-enters implementation — a plan whose contract was
	// edited while paused (or that was never approved) prompts here.
	await promptPlanApprovalIfNeeded(ctx);
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