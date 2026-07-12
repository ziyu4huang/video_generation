/**
 * goal tool + /goal command — ported from @narumitw/pi-goal v0.11.0.
 *
 * Adaptations for power-tool embedding:
 *   - Inlined isContextOverflow (was @earendil-works/pi-ai) — no external dep needed.
 *   - Inlined local PiAssistantMessage + Usage types.
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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { defineTool, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GoalOverlay, type GoalOverlayLike } from "./overlay.js";
import {
	formatBudget,
	formatDuration,
	formatTokenCount,
	type ActiveGoal,
	type GoalStatus,
} from "./format.js";

// Re-export formatters + types for tests and downstream consumers.
export { formatStatus, formatGoalMetric, formatDuration, formatTokenCount, type ActiveGoal } from "./format.js";

// ─── Local types (replaces @earendil-works/pi-ai types) ───────────────────────

interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

interface AssistantMessageContent {
	type: string;
	text?: string;
	[_: string]: unknown;
}

// ─── Goal-specific types ──────────────────────────────────────────────────────

type AgentStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

interface GoalCompleteDetails {
	goal: string;
	summary: string;
}

interface ContinuationPending {
	goalId: string;
	iteration: number;
	marker: string;
	prompt: string;
}

type GoalRecoveryKind = "provider_retry" | "compaction_retry";

interface GoalRecovery {
	goalId: string;
	kind: GoalRecoveryKind;
}

interface AssistantMessageLike {
	role: "assistant";
	stopReason?: AgentStopReason;
	errorMessage?: string;
	content?: AssistantMessageContent[];
	api?: string;
	provider?: string;
	model?: string;
	usage?: Usage;
	timestamp?: number;
}

interface GoalStateEntryData {
	goal?: ActiveGoal | null;
}

interface CommandResult {
	kind: "show" | "start" | "pause" | "resume" | "clear" | "edit";
	objective?: string;
	tokenBudget?: number;
}

interface GoalArgumentCompletion {
	value: string;
	label: string;
	description?: string;
}

export interface StatusContext {
	cwd: string;
	ui: ExtensionUIContext;
	isIdle?: () => boolean;
	hasPendingMessages?: () => boolean;
	abort?: () => void;
	sessionManager?: unknown;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const GOAL_STATE_ENTRY_TYPE = "goal-state";
const MAX_OBJECTIVE_LENGTH = 4_000;
const MAX_CANCELLED_CONTINUATION_PROMPTS = 20;
const CONTINUATION_MARKER_PREFIX = "pi-goal-continuation:";
const CONTRADICTORY_COMPLETION_PATTERNS = [
	/(?<!could\s)\bnot\s+(?:yet\s+)?(?:complete|completed|done|finished)\b/i,
	/\bstill\s+(?:incomplete|failing|failing\s+tests?|fails?)\b/i,
	/\btests?\s+(?:still\s+)?fail(?:ing)?\b/i,
] as const;
const NON_RETRYABLE_GOAL_ERROR_RE =
	/usage[_\s-]*limit|chatgpt usage limit|multi-auth rotation failed|credentials tried|unauthori[sz]ed|invalid api key/i;
const RETRYABLE_GOAL_ERROR_RE =
	/websocket closed|sse response headers timed out|headers timed out|context[_\s-]*length[_\s-]*exceeded|input exceeds the context window|provider returned error/i;
const GOAL_ARGUMENT_COMPLETIONS: readonly GoalArgumentCompletion[] = [
	{ value: "pause", label: "pause", description: "Pause the active goal" },
	{ value: "resume", label: "resume", description: "Resume a paused or budget-limited goal" },
	{ value: "clear", label: "clear", description: "Clear the current goal" },
	{ value: "edit", label: "edit", description: "Edit the current goal objective" },
	{ value: "status", label: "status", description: "Show the current goal" },
	{ value: "--tokens ", label: "--tokens", description: "Set a token budget before the goal" },
];
const EDIT_TOKEN_COMPLETION: GoalArgumentCompletion = {
	value: "edit --tokens ",
	label: "--tokens",
	description: "Set a token budget before the updated goal",
};
const STATE_FILE = join(
	process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent"),
	"pi-goal-state.json",
);

// ─── Inlined isContextOverflow (from @earendil-works/pi-ai v0.80.2) ────────────
// Inlined to avoid a Bun-isolated-linker dependency on @earendil-works/pi-ai.
// See: https://github.com/earendil-works/pi-ai/src/utils/overflow.ts

const OVERFLOW_PATTERNS = [
	/prompt is too long/i,
	/request_too_large/i,
	/input is too long for requested model/i,
	/exceeds the context window/i,
	/exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
	/input token count.*exceeds the maximum/i,
	/maximum prompt length is \d+/i,
	/reduce the length of the messages/i,
	/maximum context length is \d+ tokens/i,
	/exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
	/input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
	/exceeds the limit of \d+/i,
	/exceeds the available context size/i,
	/greater than the context length/i,
	/context window exceeds limit/i,
	/exceeded model token limit/i,
	/too large for model with \d+ maximum context length/i,
	/model_context_window_exceeded/i,
	/prompt too long; exceeded (?:max )?context length/i,
	/context[_ ]length[_ ]exceeded/i,
	/too many tokens/i,
	/token limit exceeded/i,
	/^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i,
];

const NON_OVERFLOW_PATTERNS = [
	/^(Throttling error|Service unavailable):/i,
	/rate limit/i,
	/too many requests/i,
];

function isContextOverflow(message: { stopReason?: string; errorMessage?: string; usage?: Usage }, contextWindow?: number): boolean {
	if (message.stopReason === "error" && message.errorMessage) {
		const isNonOverflow = NON_OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!));
		if (!isNonOverflow && OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!))) {
			return true;
		}
	}
	if (contextWindow && message.stopReason === "stop" && message.usage) {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens > contextWindow) {
			return true;
		}
	}
	if (contextWindow && message.stopReason === "length" && message.usage && message.usage.output === 0) {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens >= contextWindow * 0.99) {
			return true;
		}
	}
	return false;
}

// ─── Module state ─────────────────────────────────────────────────────────────

let activeGoal: ActiveGoal | undefined;
let extensionApi: ExtensionAPI | undefined;
let continuationPending: ContinuationPending | undefined;
let goalRecovery: GoalRecovery | undefined;
let staleGoalToolCallsBlocked = false;
let goalOverlay: GoalOverlayLike | undefined;
/** Periodic refresh of the active-goal overlay (elapsed time / budget metric). */
let statusRefreshTimer: ReturnType<typeof setInterval> | undefined;
/** Most recent ctx, captured so the refresh tick can recompute usage + poke the overlay. */
let latestCtx: StatusContext | undefined;
const cancelledContinuationMarkers = new Set<string>();
const STATUS_REFRESH_INTERVAL_MS = 1_000;

// ─── Coordination seam (Plan A: goal ⇄ planning-with-files mutual-exclusion) ──

/**
 * Whether a /goal is currently in the "active" (driving) state.
 *
 * Exported so planning-with-files can query it (dynamic import + fallback to
 * false) and yield its own before_agent_start injection + agent_end
 * auto-continue to the goal, which owns iteration counting, token budget, and
 * recovery. Returns FALSE for paused / budget_limited / complete / no-goal —
 * so planning may resume its own continuation when the goal is NOT actively
 * driving (e.g. user paused the goal).
 */
export function isGoalActive(): boolean {
	return activeGoal?.status === "active";
}

// ─── Tool definition ──────────────────────────────────────────────────────────

const goalCompleteTool = defineTool({
	name: "goal_complete",
	label: "Goal Complete",
	description:
		"Mark the active /goal as complete after all required work is done and verified. Do not use for partial progress, blockers, failing, or unverified work.",
	promptSnippet: "Mark the active /goal as complete after fully finishing and verifying it",
	promptGuidelines: [
		"Keep working until fully complete—audit every requirement against files/tests/state before goal_complete. Never stop at partial progress or a plan.",
	],
	parameters: Type.Object({
		summary: Type.String({
			description:
				"State what was completed and what evidence verified it. Do not use this tool to report partial progress, blockers, failures, or remaining work.",
		}),
	}),
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: (msg: any) => void, ctx: any) {
		const completedGoal = activeGoal;
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
			persistGoal(completedGoal);
			updateStatus(ctx, completedGoal);
			const rejection = `Goal completion rejected: ${rejectionReason}.`;
			ctx.ui.notify(rejection, "warning");
			return {
				content: [{ type: "text", text: rejection }],
				details: { goal, summary } satisfies GoalCompleteDetails,
			};
		}

		// Plan A coordination seam: block goal_complete while a planning-with-files
		// plan has open phases. The goal's own summary audit can't see plan state; this
		// closes the gap. Release valve: /plan-done (writes the close marker →
		// __piPlanIncomplete returns false). Best-effort: if planning-with-files isn't
		// loaded or errors, the gate is a no-op (goal_complete proceeds).
		const planningReason = planningGateBlocking(ctx.cwd);
		if (planningReason) {
			updateGoalUsage(completedGoal, ctx);
			persistGoal(completedGoal);
			updateStatus(ctx, completedGoal);
			const rejection =
				`Goal completion rejected: ${planningReason}. ` +
				"Finish the remaining plan phases, or run /plan-done to close the plan, then call goal_complete again.";
			ctx.ui.notify(rejection, "warning");
			return {
				content: [{ type: "text", text: rejection }],
				details: { goal, summary } satisfies GoalCompleteDetails,
			};
		}

		if (completedGoal) {
			activeGoal = transitionGoal(completedGoal, "complete");
			updateGoalUsage(activeGoal, ctx);
			persistGoal(activeGoal);
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
	extensionApi = pi;
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
		activeGoal = loadGoalFromSession(ctx);
		if (activeGoal) updateStatus(ctx, activeGoal);
		else goalOverlay?.update(undefined);
	});

	pi.on("session_shutdown", (_event: unknown, _ctx: StatusContext) => {
		if (activeGoal) persistGoal(activeGoal);
		clearContinuationTracking();
		clearGoalRecovery();
		clearStaleGoalToolCallBlock();
		stopStatusRefreshTimer();
		goalOverlay?.dispose();
	});

	pi.on("session_before_compact", (_event: unknown, ctx: StatusContext) => {
		if (!activeGoal || activeGoal.status !== "active") return;
		updateGoalUsage(activeGoal, ctx);
		cancelContinuationPending();
		persistGoal(activeGoal);
		updateStatus(ctx, activeGoal);
	});

	pi.on("session_compact", async (event: unknown, ctx: StatusContext) => {
		if (!activeGoal || activeGoal.status !== "active") {
			clearGoalRecovery();
			return;
		}

		const restoredGoal = loadGoalFromSession(ctx);
		if (restoredGoal?.id === activeGoal.id) activeGoal = restoredGoal;
		updateGoalUsage(activeGoal, ctx);
		persistGoal(activeGoal);
		updateStatus(ctx, activeGoal);

		const wasPiRetry = isPiOwnedCompactionRetry(event, activeGoal.id);
		clearGoalRecoveryForGoal(activeGoal.id);
		if (wasPiRetry || hasPendingMessages(ctx)) return;
		await sendContinuationPrompt(pi, ctx, activeGoal);
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
		if (!staleGoalToolCallsBlocked) return;
		if (!activeGoal || activeGoal.status !== "paused") {
			clearStaleGoalToolCallBlock();
			return;
		}
		return {
			block: true,
			reason: "Blocked stale /goal tool call after the goal was paused or interrupted.",
		};
	});

	pi.on("before_agent_start", (event: { systemPrompt?: string; prompt?: string }) => {
		if (event.prompt) markContinuationDelivered(event.prompt);
		if (!activeGoal || activeGoal.status !== "active") return;

		return {
			systemPrompt: `${event.systemPrompt ?? ""}\n\n${buildGoalSystemPrompt(activeGoal)}`,
		};
	});

	pi.on("agent_end", async (event: { messages?: unknown[] }, ctx: StatusContext) => {
		if (!activeGoal || activeGoal.status !== "active") return;

		const goalId = activeGoal.id;
		const hadPendingContinuation = continuationPending?.goalId === goalId;
		const finalAssistant = findFinalAssistantMessage(event.messages ?? []);

		if (!hadPendingContinuation) activeGoal = incrementGoal(activeGoal);
		updateGoalUsage(activeGoal, ctx);

		if (finalAssistant?.stopReason === "aborted" || finalAssistant?.stopReason === "error") {
			if (isRetryableGoalInterruption(finalAssistant)) {
				goalRecovery = {
					goalId,
					kind: isGoalContextOverflow(finalAssistant) ? "compaction_retry" : "provider_retry",
				};
				cancelContinuationPending();
				persistGoal(activeGoal);
				updateStatus(ctx, activeGoal);
				return;
			}
			clearGoalRecoveryForGoal(goalId);
			pauseGoalAfterAgentEnd(ctx, activeGoal, finalAssistant);
			return;
		}

		clearGoalRecoveryForGoal(goalId);

		if (activeGoal.tokenBudget !== undefined && activeGoal.tokensUsed >= activeGoal.tokenBudget) {
			cancelContinuationPending();
			activeGoal = transitionGoal(activeGoal, "budget_limited");
			persistGoal(activeGoal);
			updateStatus(ctx, activeGoal);
			ctx.ui.notify(`Goal token budget reached: ${formatBudget(activeGoal)}`, "warning");
			return;
		}

		persistGoal(activeGoal);
		updateStatus(ctx, activeGoal);

		if (hadPendingContinuation) {
			if (hasPendingMessages(ctx)) return;
			if (continuationPending?.goalId === goalId) continuationPending = undefined;
		}

		const currentGoal = activeGoal;
		if (!currentGoal || currentGoal.id !== goalId || currentGoal.status !== "active") return;
		if (hasPendingMessages(ctx)) return;
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

	const existingGoal = activeGoal?.status !== "complete" ? activeGoal : undefined;
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
	activeGoal = createGoal(objective, tokenBudget, currentTokenTotal(ctx));
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);
	ctx.ui.notify(existingGoal ? `Goal replaced: ${objective}` : `Goal started: ${objective}`, "info");
	await sendGoalPrompt(pi, ctx, activeGoal);
}

function pauseGoal(ctx: StatusContext) {
	if (!activeGoal) {
		ctx.ui.notify("No active goal.", "info");
		return;
	}
	if (activeGoal.status !== "active") {
		ctx.ui.notify(`Goal is ${activeGoal.status}; only active goals can be paused.`, "warning");
		return;
	}
	cancelContinuationPending();
	blockStaleGoalToolCalls();
	abortCurrentTurn(ctx);
	activeGoal = transitionGoal(activeGoal, "paused");
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);
	ctx.ui.notify(`Goal paused: ${activeGoal.text}`, "info");
}

async function resumeGoal(pi: ExtensionAPI, ctx: StatusContext) {
	if (!activeGoal) {
		ctx.ui.notify("No active goal.", "info");
		return;
	}
	if (activeGoal.status !== "paused" && activeGoal.status !== "budget_limited") {
		ctx.ui.notify(`Goal is ${activeGoal.status}; only paused or budget-limited goals can be resumed.`, "warning");
		return;
	}
	clearGoalRecovery();
	clearStaleGoalToolCallBlock();
	activeGoal = transitionGoal(activeGoal, "active");
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);
	if (activeGoal.status !== "active") {
		ctx.ui.notify(`Goal token budget is still reached: ${formatBudget(activeGoal)}`, "warning");
		return;
	}
	ctx.ui.notify(`Goal resumed: ${activeGoal.text}`, "info");
	await sendResumePrompt(pi, ctx, activeGoal);
}

function clearGoal(ctx: StatusContext) {
	if (!activeGoal) {
		ctx.ui.notify("No active goal.", "info");
		cancelContinuationPending();
		clearGoalRecovery();
		clearStaleGoalToolCallBlock();
		clearPersistedGoal(ctx.cwd);
		goalOverlay?.update(undefined);
		return;
	}

	const stoppedGoal = activeGoal.text;
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
	if (!activeGoal) {
		ctx.ui.notify("No active goal. Use /goal <objective> to start one.", "warning");
		return;
	}

	updateGoalUsage(activeGoal, ctx);
	cancelContinuationPending();
	clearGoalRecovery();
	activeGoal = normalizeGoalForBudget({
		...activeGoal,
		text: objective,
		status: editedGoalStatus(activeGoal.status),
		tokenBudget: tokenBudget ?? activeGoal.tokenBudget,
		updatedAt: Date.now(),
	});
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);
	ctx.ui.notify(`Goal updated: ${objective}`, "info");
	if (activeGoal.status === "active") {
		clearStaleGoalToolCallBlock();
		await sendObjectiveUpdatedPrompt(pi, ctx, activeGoal);
	}
}

function showGoal(ctx: StatusContext) {
	if (!activeGoal) {
		ctx.ui.notify("Usage: /goal <objective>\nNo goal is currently set.", "info");
		goalOverlay?.update(undefined);
		return;
	}
	updateGoalUsage(activeGoal, ctx);
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);
	ctx.ui.notify(goalSummary(activeGoal), "info");
}

function createGoal(text: string, tokenBudget: number | undefined, baselineTokens: number): ActiveGoal {
	const now = Date.now();
	return {
		id: randomUUID(),
		text,
		status: "active",
		startedAt: now,
		updatedAt: now,
		iteration: 0,
		tokenBudget,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		baselineTokens,
	};
}

function transitionGoal(goal: ActiveGoal, status: GoalStatus): ActiveGoal {
	return normalizeGoalForBudget({ ...goal, status, updatedAt: Date.now() });
}

function editedGoalStatus(status: GoalStatus): GoalStatus {
	return status === "paused" ? "paused" : "active";
}

function normalizeGoalForBudget(goal: ActiveGoal): ActiveGoal {
	if (
		goal.status === "active" &&
		goal.tokenBudget !== undefined &&
		goal.tokensUsed >= goal.tokenBudget
	) {
		return { ...goal, status: "budget_limited" };
	}
	return goal;
}

function incrementGoal(goal: ActiveGoal): ActiveGoal {
	return { ...goal, iteration: goal.iteration + 1, updatedAt: Date.now() };
}

function pauseGoalAfterAgentEnd(
	ctx: StatusContext,
	goal: ActiveGoal,
	assistant: AssistantMessageLike,
) {
	cancelContinuationPending();
	blockStaleGoalToolCalls();
	abortCurrentTurn(ctx);
	activeGoal = transitionGoal(goal, "paused");
	persistGoal(activeGoal);
	updateStatus(ctx, activeGoal);

	const reason = assistant.stopReason === "aborted" ? "interruption" : "agent error";
	const details = assistant.errorMessage ? ` (${truncateNotification(assistant.errorMessage)})` : "";
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
	if (!activeGoal || activeGoal.status !== "active" || !latestCtx) return;
	activeGoal.timeUsedSeconds = Math.max(0, Math.floor((Date.now() - activeGoal.startedAt) / 1000));
	activeGoal.tokensUsed = Math.max(0, currentTokenTotal(latestCtx) - activeGoal.baselineTokens);
	activeGoal.updatedAt = Date.now();
	goalOverlay?.update(activeGoal);
}

function stopStatusRefreshTimer() {
	if (!statusRefreshTimer) return;
	clearInterval(statusRefreshTimer);
	statusRefreshTimer = undefined;
}

/** Start a 1s refresh interval only while a goal is active; stop otherwise. */
function syncStatusRefreshTimer() {
	const shouldRun = activeGoal?.status === "active";
	if (shouldRun && !statusRefreshTimer) {
		statusRefreshTimer = setInterval(tickActiveGoalStatus, STATUS_REFRESH_INTERVAL_MS);
		// Never keep the process alive just for the status ticker (tests, -p batch).
		statusRefreshTimer?.unref?.();
	} else if (!shouldRun && statusRefreshTimer) {
		stopStatusRefreshTimer();
	}
}

// ─── Argument completions & parsing ───────────────────────────────────────────

export function completeGoalArguments(argumentPrefix: string): GoalArgumentCompletion[] | null {
	const prefix = argumentPrefix.trimStart();
	if (prefix === "") return [...GOAL_ARGUMENT_COMPLETIONS];

	const editOptionPrefix = /^edit\s+(\S*)$/.exec(prefix)?.[1];
	if (editOptionPrefix !== undefined) {
		return editOptionPrefix === "" || "--tokens".startsWith(editOptionPrefix)
			? [EDIT_TOKEN_COMPLETION]
			: null;
	}

	if (/\s/.test(prefix)) return null;

	const matches = GOAL_ARGUMENT_COMPLETIONS.filter(
		(item) => item.value.startsWith(prefix) || item.label.startsWith(prefix),
	);
	return matches.length > 0 ? [...matches] : null;
}

export function parseCommand(args: string): CommandResult | string {
	const tokens = tokenize(args.trim());
	if (tokens.length === 0) return { kind: "show" };

	const [first, ...rest] = tokens;
	if (first === "pause") return rest.length === 0 ? { kind: "pause" } : "Usage: /goal pause";
	if (first === "resume") return rest.length === 0 ? { kind: "resume" } : "Usage: /goal resume";
	if (first === "clear" || first === "stop") return rest.length === 0 ? { kind: "clear" } : "Usage: /goal clear";
	if (first === "status") return rest.length === 0 ? { kind: "show" } : "Usage: /goal status";
	if (first === "edit") return parseObjective("edit", rest);
	return parseObjective("start", tokens);
}

function parseObjective(kind: "start" | "edit", tokens: string[]): CommandResult | string {
	let tokenBudget: number | undefined;
	const objectiveTokens = [...tokens];

	if (objectiveTokens[0] === "--tokens") {
		const rawBudget = objectiveTokens[1];
		if (!rawBudget) return "Usage: /goal --tokens 100k <goal_to_complete>";
		const parsedBudget = parseTokenBudget(rawBudget);
		if (parsedBudget === undefined) return `Invalid token budget: ${rawBudget}`;
		tokenBudget = parsedBudget;
		objectiveTokens.splice(0, 2);
	}

	if (objectiveTokens.length === 0) {
		return kind === "edit" ? "Usage: /goal edit <goal_to_complete>" : "Usage: /goal <goal_to_complete>";
	}

	return { kind, objective: objectiveTokens.join(" "), tokenBudget };
}

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;

	for (const char of input) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) tokens.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

export function parseTokenBudget(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)([km])?$/iu.exec(value.trim());
	if (!match) return undefined;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return undefined;
	const multiplier = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1;
	return Math.floor(amount * multiplier);
}

export function validateObjective(objective: string): string | undefined {
	const trimmed = objective.trim();
	if (!trimmed) return "Usage: /goal <goal_to_complete>";
	if (trimmed.length > MAX_OBJECTIVE_LENGTH) {
		return `Goal objective is too long (${trimmed.length}/${MAX_OBJECTIVE_LENGTH} characters). Put long instructions in a file and reference it from /goal instead.`;
	}
	return undefined;
}

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
	if (continuationPending?.goalId === goal.id) return false;
	if (hasPendingMessages(ctx)) return false;

	const marker = continuationMarker(goal);
	const prompt = buildContinuePrompt(goal, marker);
	continuationPending = { goalId: goal.id, iteration: goal.iteration, marker, prompt };
	const sent = await sendPrompt(pi, ctx, prompt);
	if (!sent && continuationPending?.marker === marker) continuationPending = undefined;
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
	latestCtx = ctx;
	goalOverlay?.update(activeGoal);
	syncStatusRefreshTimer();
}

function goalSummary(goal: ActiveGoal) {
	return [
		`Goal: ${goal.text}`,
		`Status: ${goal.status}`,
		`Iteration: ${goal.iteration}`,
		`Elapsed: ${formatDuration(goal.timeUsedSeconds)}`,
		`Tokens: ${goal.tokenBudget === undefined ? formatTokenCount(goal.tokensUsed) : formatBudget(goal)}`,
		`Commands: ${goalCommandHint(goal.status)}`,
	].join("\n");
}

function goalCommandHint(status: GoalStatus) {
	if (status === "active") return "/goal edit <objective>, /goal pause, /goal clear";
	if (status === "paused") return "/goal edit <objective>, /goal resume, /goal clear";
	return "/goal edit <objective>, /goal clear";
}

// ─── Prompt templates ─────────────────────────────────────────────────────────

function buildGoalPrompt(goal: ActiveGoal) {
	const budgetLine = goal.tokenBudget === undefined ? "" : `\nToken budget: ${formatTokenCount(goal.tokenBudget)}.`;
	return `Goal mode is active. Complete this goal fully:\n\n${goalObjectiveBlock(goal)}${budgetLine}\n\n${goalPersistenceRules("this goal")}`;
}

function buildObjectiveUpdatedPrompt(goal: ActiveGoal) {
	const budgetLine = goal.tokenBudget === undefined ? "" : `\nToken budget: ${formatBudget(goal)} used.`;
	return `The active /goal objective was updated. Continue working toward this goal:\n\n${goalObjectiveBlock(goal)}${budgetLine}\n\n${goalPersistenceRules("the updated goal")}`;
}

function buildResumePrompt(goal: ActiveGoal) {
	const budgetLine = goal.tokenBudget === undefined ? "" : `\nToken budget: ${formatBudget(goal)} used.`;
	return `The user explicitly resumed the paused /goal. Continue working toward this goal:\n\n${goalObjectiveBlock(goal)}${budgetLine}\n\n${goalPersistenceRules("this goal")}`;
}

export function buildGoalSystemPrompt(goal: ActiveGoal) {
	const budgetLine = goal.tokenBudget === undefined ? "" : `\n- Respect the goal token budget (${formatBudget(goal)} used).`;
	const planLine = planProgressLineFromPeer();
	const planBullet = planLine ? `\n- Active plan progress: ${planLine}. Treat the plan as your roadmap, not a stopping point.` : "";
	return `Active /goal:\n${goalObjectiveBlock(goal)}\n\nGoal-mode rules:\n- Keep going until the active goal is completely resolved end-to-end.\n- Treat the current worktree, command output, tests, and external state as authoritative.\n- Do not redefine the goal into a smaller task; audit every requirement before completion.\n- Do not stop at analysis, a plan, TODO list, partial fixes, or suggested next steps.\n- ${THREE_LAYER_GUIDANCE}\n- Autonomously perform implementation and verification with the available tools when they are needed to complete the goal.\n- Persevere through recoverable tool failures by trying reasonable alternatives instead of yielding early.\n- If the goal is not complete at the end of a turn, expect an automatic continuation and keep working from where you left off.\n- Only call the goal_complete tool after the goal is fully complete and verified.${planBullet}${budgetLine}`;
}

function buildContinuePrompt(goal: ActiveGoal, marker: string) {
	const planLine = planProgressLineFromPeer();
	const planNote = planLine ? `\nActive plan progress: ${planLine}. Continue the next open phase, then mark it complete in task_plan.md.` : "";
	return `Continue the active /goal until it is complete:\n\n${goalObjectiveBlock(goal)}\n\nThis is automatic continuation #${goal.iteration}. Current files, command output, tests, and external state are authoritative; re-check them as needed. ${goalPersistenceRules("this goal")}${planNote}\n\n${continuationMarkerComment(marker)}`;
}

function goalObjectiveBlock(goal: ActiveGoal) {
	return `<goal_objective>\n${escapeXmlText(goal.text)}\n</goal_objective>`;
}

function goalPersistenceRules(goalLabel: string) {
	return `Keep going until ${goalLabel} is completely resolved end-to-end. Do not redefine ${goalLabel} into a smaller task. Do not stop at analysis, a plan, TODO list, partial fixes, or suggested next steps. Autonomously perform implementation and verification with the available tools when they are needed. Treat the current worktree, command output, tests, and external state as authoritative. If a tool call fails, try reasonable alternatives instead of yielding early. Before calling goal_complete, audit ${goalLabel} requirement by requirement against the verified current state. Only call the goal_complete tool after ${goalLabel} is fully complete and verified.`;
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
	staleGoalToolCallsBlocked = true;
}

function clearStaleGoalToolCallBlock() {
	staleGoalToolCallsBlocked = false;
}

function clearGoalRecovery() {
	goalRecovery = undefined;
}

function clearGoalRecoveryForGoal(goalId: string) {
	if (goalRecovery?.goalId === goalId) goalRecovery = undefined;
}

function isPiOwnedCompactionRetry(event: unknown, goalId: string) {
	const compaction = event as { reason?: unknown; willRetry?: unknown };
	if (compaction.willRetry === true) return true;
	return (
		goalRecovery?.goalId === goalId &&
		goalRecovery.kind === "compaction_retry" &&
		(compaction.reason === undefined || compaction.reason === "overflow")
	);
}

export function isContradictoryCompletionSummary(summary: string) {
	return CONTRADICTORY_COMPLETION_PATTERNS.some((pattern) => pattern.test(summary));
}

/**
 * Plan A coordination seam: read planning-with-files' published
 * `globalThis.__piPlanIncomplete` to decide whether goal_complete should be
 * blocked by an open (exists + not closed + incomplete-phases) plan. Returns an
 * actionable reason string, or undefined if no gate applies (planning-with-files
 * not loaded, no plan, plan closed, or all phases complete). Best-effort: a
 * peer-extension error never blocks goal_complete.
 */
export function planningGateBlocking(cwd: string): string | undefined {
	const fn = (globalThis as Record<string, unknown> | undefined)?.__piPlanIncomplete;
	if (typeof fn !== "function") return undefined;
	try {
		if ((fn as (cwd: string) => boolean)(cwd)) {
			return "a planning-with-files plan still has incomplete phases";
		}
	} catch {
		// best-effort: never block goal_complete on a peer-extension read error
	}
	return undefined;
}

/**
 * Fusion seam: read planning-with-files' published `globalThis.__piPlanSummary`
 * to surface the active plan's phase progress. When the goal drives (and
 * planning yielded its injection per Plan A), the agent would otherwise lose
 * plan visibility — this keeps the roadmap in front of it. Best-effort: empty
 * string when planning is absent / no plan / latestCtx unset / error.
 */
export function planProgressLineFromPeer(): string {
	const cwd = latestCtx?.cwd;
	if (!cwd) return "";
	const fn = (globalThis as Record<string, unknown> | undefined)?.__piPlanSummary;
	if (typeof fn !== "function") return "";
	try {
		return (fn as (cwd: string) => string | null)(cwd) ?? "";
	} catch {
		return "";
	}
}

// Three-layer fusion guidance: teaches the agent that planning-with-files (the
// roadmap) and the `todo` tool (in-session steps) are tools to FINISH the goal,
// not stopping points. Goal drives; the other two structure the drive.
const THREE_LAYER_GUIDANCE =
	"You have three cooperating layers: this /goal (drives to completion), " +
	"planning-with-files (the cross-session phase roadmap in task_plan.md), and " +
	"the `todo` tool (in-session step tracking). Use the plan as your roadmap " +
	"and todo to track steps — neither is a stopping point; they are tools to finish this goal.";

export function isRetryableGoalInterruption(assistant: AssistantMessageLike) {
	if (assistant.stopReason !== "error") return false;
	if (!assistant.errorMessage) return false;
	if (NON_RETRYABLE_GOAL_ERROR_RE.test(assistant.errorMessage)) return false;
	return isGoalContextOverflow(assistant) || RETRYABLE_GOAL_ERROR_RE.test(assistant.errorMessage);
}

function isGoalContextOverflow(assistant: AssistantMessageLike) {
	return isContextOverflow(assistant);
}

// ─── Continuation tracking ────────────────────────────────────────────────────

function clearContinuationTracking() {
	continuationPending = undefined;
	cancelledContinuationMarkers.clear();
}

function cancelContinuationPending() {
	if (continuationPending) rememberCancelledContinuationMarker(continuationPending.marker);
	continuationPending = undefined;
}

function rememberCancelledContinuationMarker(marker: string) {
	cancelledContinuationMarkers.add(marker);
	if (cancelledContinuationMarkers.size <= MAX_CANCELLED_CONTINUATION_PROMPTS) return;
	const oldest = cancelledContinuationMarkers.values().next().value;
	if (oldest) cancelledContinuationMarkers.delete(oldest);
}

function consumeCancelledContinuationPrompt(prompt: string) {
	const marker = extractContinuationMarker(prompt);
	return marker ? cancelledContinuationMarkers.delete(marker) : false;
}

function markContinuationDelivered(prompt: string) {
	const marker = extractContinuationMarker(prompt);
	if (marker && continuationPending?.marker === marker) continuationPending = undefined;
}

function continuationMarker(goal: ActiveGoal) {
	return `${goal.id}:${goal.iteration}:${randomUUID()}`;
}

function continuationMarkerComment(marker: string) {
	return `<!-- ${CONTINUATION_MARKER_PREFIX}${marker} -->`;
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

export function findFinalAssistantMessage(messages: unknown[]): AssistantMessageLike | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message || typeof message !== "object") continue;
		const candidate = message as Record<string, unknown>;
		if (candidate.role !== "assistant") continue;
		const assistant: AssistantMessageLike = {
			role: "assistant",
			stopReason: isAgentStopReason(candidate.stopReason) ? candidate.stopReason : undefined,
			errorMessage: typeof candidate.errorMessage === "string" ? candidate.errorMessage : undefined,
		};
		if (Array.isArray(candidate.content)) assistant.content = candidate.content as AssistantMessageContent[];
		if (typeof candidate.api === "string") assistant.api = candidate.api;
		if (typeof candidate.provider === "string") assistant.provider = candidate.provider;
		if (typeof candidate.model === "string") assistant.model = candidate.model;
		if (typeof candidate.timestamp === "number") assistant.timestamp = candidate.timestamp;
		const usage = normalizeUsage(candidate.usage);
		if (usage) assistant.usage = usage;
		return assistant;
	}
	return undefined;
}

function isAgentStopReason(value: unknown): value is AgentStopReason {
	return ["stop", "length", "toolUse", "error", "aborted"].includes(String(value));
}

function normalizeUsage(value: unknown): Usage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const usage = value as Partial<Usage>;
	if (typeof usage.input !== "number" || typeof usage.output !== "number") return undefined;
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
		totalTokens: usage.totalTokens ?? usage.input + usage.output + (usage.cacheRead ?? 0),
		cost: {
			input: usage.cost?.input ?? 0,
			output: usage.cost?.output ?? 0,
			cacheRead: usage.cost?.cacheRead ?? 0,
			cacheWrite: usage.cost?.cacheWrite ?? 0,
			total: usage.cost?.total ?? 0,
		},
	};
}

// ─── XML/text helpers ─────────────────────────────────────────────────────────

function escapeXmlText(value: string) {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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

// Deep-clone before handing to the session store. The runtime may freeze or
// canonicalize entry data; without a clone, our live `activeGoal` reference
// could be frozen too, after which any updateGoalUsage(activeGoal) throws
// "Attempted to assign to readonly property". The wrapper object is fresh,
// but the nested `goal` must also be a copy we don't share with the store.
function persistGoal(goal: ActiveGoal) {
	extensionApi?.appendEntry(GOAL_STATE_ENTRY_TYPE, { goal: cloneGoal(goal) });
}

function clearPersistedGoal(cwd: string) {
	extensionApi?.appendEntry(GOAL_STATE_ENTRY_TYPE, { goal: null });
	clearLegacyPersistedGoal(cwd);
}

function loadGoalFromSession(ctx: StatusContext): ActiveGoal | undefined {
	const sessionManager = ctx.sessionManager as
		| {
				getBranch?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
				getEntries?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
			}
		| undefined;
	const entries = sessionManager?.getBranch?.() ?? sessionManager?.getEntries?.() ?? [];
	const entry = entries
		.filter((entry) => entry.type === "custom" && entry.customType === GOAL_STATE_ENTRY_TYPE)
		.pop();
	const data = entry?.data as GoalStateEntryData | undefined;
	return isGoal(data?.goal) && data.goal.status !== "complete" ? cloneGoal(data.goal) : undefined;
}

function clearActiveGoal(ctx: StatusContext) {
	cancelContinuationPending();
	clearGoalRecovery();
	clearStaleGoalToolCallBlock();
	activeGoal = undefined;
	clearPersistedGoal(ctx.cwd);
	goalOverlay?.update(undefined);
	stopStatusRefreshTimer();
}

// Transient "✓ goal complete" flash (~8s) shown after goal_complete, then the
// overlay hides itself. The flash timer + render live entirely in GoalOverlay.
// The status-refresh interval (statusRefreshTimer) is a SEPARATE module-level
// timer that ticks the elapsed-time metric while a goal is active; it is
// stopped on session_shutdown / clearActiveGoal / any non-active transition
// (syncStatusRefreshTimer), so it never goes stale across sessions.
function showCompletionStatus(_ctx: StatusContext, objective: string) {
	goalOverlay?.showCompletion(objective);
}

// ─── Legacy state file ────────────────────────────────────────────────────────

function readState(): Record<string, unknown> {
	if (!existsSync(STATE_FILE)) return {};
	try {
		const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function clearLegacyPersistedGoal(cwd: string) {
	if (!existsSync(STATE_FILE)) return;
	const goals = readState();
	delete goals[cwd];
	mkdirSync(dirname(STATE_FILE), { recursive: true });
	writeFileSync(STATE_FILE, `${JSON.stringify(goals, null, 2)}\n`);
}

// ─── Validation ───────────────────────────────────────────────────────────────

// Clone a goal so callers never mutate the session store's (possibly frozen)
// canonical reference. structuredClone keeps the plain-JSON shape of ActiveGoal.
function cloneGoal(goal: ActiveGoal): ActiveGoal {
	try {
		return structuredClone(goal);
	} catch {
		// Fallback for environments without structuredClone — ActiveGoal is plain data.
		return JSON.parse(JSON.stringify(goal)) as ActiveGoal;
	}
}

function isGoal(value: unknown): value is ActiveGoal {
	if (!value || typeof value !== "object") return false;
	const goal = value as Partial<ActiveGoal>;
	return (
		typeof goal.id === "string" &&
		typeof goal.text === "string" &&
		["active", "paused", "budget_limited", "complete"].includes(String(goal.status)) &&
		typeof goal.startedAt === "number" &&
		typeof goal.updatedAt === "number" &&
		typeof goal.iteration === "number" &&
		typeof goal.tokensUsed === "number" &&
		typeof goal.timeUsedSeconds === "number" &&
		typeof goal.baselineTokens === "number"
	);
}
