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
import { defineTool, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getPlanSummary, isPlanIncomplete } from "../plan/coordinator.js";
import { GoalOverlay, type GoalOverlayLike } from "./overlay.js";
import { formatBudget, type ActiveGoal, type GoalAuditOptions } from "./format.js";
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
import { backoffMs, shouldPauseAfterBackoff, shouldHeartbeatRefire, accountTurnForNudges, shouldWedgeAlert, HEARTBEAT_INTERVAL_MS, HEARTBEAT_MAX_NUDGES, WEDGE_ALERT_DEFAULT_MINUTES } from "./backoff.js";
import type { GoalAuditorResult } from "./shield.js";
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
// Captured from goal()'s `pi` arg so the heartbeat interval (started later, in a
// setInterval closure) can call sendContinuationPrompt. Mirrors how goalOverlay
// is captured at registration. Reassigned on every goal() call.
let piRef: ExtensionAPI | undefined;
const STATUS_REFRESH_INTERVAL_MS = 1_000;

// ─── T04 opt-in auditor: test seam + module singleton ────────────────────────
// `auditRunner` is a module-level singleton so tests can inject a fake via the
// exported `__setAuditRunnerForTest` seam — the ONLY way to avoid invoking a
// real model. The default lazy-imports `runGoalCompletionAuditor` from
// ./auditor.js, which transitively imports createAgentSession from
// pi-coding-agent; the dynamic `import()` only resolves when an audit actually
// runs (inside the `if (completedGoal.auditEnabled)` guard in goal_complete),
// so default (non-audited) sessions pay ZERO import cost.

type AuditRunnerArgs = {
	ctx: ExtensionContext;
	goal: ActiveGoal;
	completionSummary: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Model is a broad union from pi-ai; the seam only forwards it to runGoalCompletionAuditor.
	model?: any;
};
type AuditRunner = (args: AuditRunnerArgs) => Promise<GoalAuditorResult>;

let auditRunner: AuditRunner = async (args) => {
	const { runGoalCompletionAuditor } = await import("./auditor.js");
	return runGoalCompletionAuditor(args);
};

/** Test seam: override the audit runner. Pass `undefined` to restore the default. */
export function __setAuditRunnerForTest(fn: AuditRunner | undefined): void {
	auditRunner =
		fn ??
		(async (args) => {
			const { runGoalCompletionAuditor } = await import("./auditor.js");
			return runGoalCompletionAuditor(args);
		});
}

/**
 * Parse a `"provider/id"` override string into a Model ref (best-effort; used
 * for the `--model` flag). The session's modelRegistry resolves provider/id via
 * the parent runtime; createAgentSession accepts a bare `{provider,id}` object.
 * A bare id (no slash) is returned as-is so a fully-qualified model string works too.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- Model is a broad union; a structural {provider,id} is the documented override shape. */
function parseModelRef(ref: string): any {
	const slash = ref.indexOf("/");
	if (slash < 1) return ref;
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

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
		let completedGoal = goalState.activeGoal;
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

		// T04 opt-in auditor: gate completion on an isolated read-only audit.
		// The entire block is guarded by `auditEnabled`, so a non-audited goal's
		// goal_complete is byte-for-byte the pre-T04 path (the auditor module is
		// not even imported). D3 routing: approve/impossible → fall through to the
		// normal complete transition; disapprove → bounded re-loop (stay active,
		// return the finding, terminate:false so the agent self-corrects in-turn);
		// 3 consecutive disapprovals → pause + escalate; infra error → never
		// complete (let the agent/user retry).
		if (completedGoal.auditEnabled) {
			const { AUDIT_MAX_RETRIES, AUDIT_HISTORY_CAP } = await import("./auditor.js");
			ctx.ui.notify("Auditing completion…", "info");
			const auditResult = await auditRunner({
				ctx,
				goal: completedGoal,
				completionSummary: summary,
				model: completedGoal.auditorModel ? parseModelRef(completedGoal.auditorModel) : undefined,
			});
			// Cap the audit history on the goal (mutate a clone, reassign activeGoal,
			// persist) so the verdict trail survives compaction + is visible on the goal.
			completedGoal = {
				...completedGoal,
				auditHistory: pushCapped(completedGoal.auditHistory ?? [], auditResult, AUDIT_HISTORY_CAP),
			};
			goalState.activeGoal = completedGoal;
			persistGoal(goalState.extensionApi as ExtensionAPI, completedGoal);

			// Infrastructure error (error && !disapproved) → never complete; let the
			// agent/user retry. A disapprove WITH an error field is still a verdict.
			if (auditResult.error && !auditResult.disapproved) {
				ctx.ui.notify(`Goal audit failed (infrastructure): ${auditResult.error}`, "warning");
				return {
					content: [{ type: "text", text: `Audit could not produce a verdict: ${auditResult.error}. Re-verify and call goal_complete again.` }],
					details: { goal, summary } satisfies GoalCompleteDetails,
				};
			}
			// Impossible → the objective can never be satisfied; complete with a note
			// (fall through to the normal complete transition below).
			if (auditResult.impossible) {
				ctx.ui.notify(`Goal marked impossible by audit: ${auditResult.impossibleReason ?? "unspecified"}`, "info");
			}
			// Disapproved → bounded re-loop (D3): stay active, return the finding,
			// terminate defaults to false so the agent continues in-turn and self-corrects.
			if (auditResult.disapproved) {
				const attempts = (completedGoal.auditAttempts ?? 0) + 1;
				completedGoal = { ...completedGoal, auditAttempts: attempts };
				goalState.activeGoal = completedGoal;
				persistGoal(goalState.extensionApi as ExtensionAPI, completedGoal);
				if (attempts >= AUDIT_MAX_RETRIES) {
					// Escalate: pause the goal so the user decides.
					goalState.activeGoal = transitionGoal(completedGoal, "paused");
					persistGoal(goalState.extensionApi as ExtensionAPI, goalState.activeGoal);
					updateStatus(ctx, goalState.activeGoal);
					ctx.ui.notify(`Goal audit disapproved ${attempts}× — paused for review. Address the audit findings or /goal resume.`, "warning");
					return {
						content: [{ type: "text", text: `Audit disapproved ${attempts}× and paused the goal. Findings: ${auditResult.output.slice(0, 500)}` }],
						details: { goal, summary } satisfies GoalCompleteDetails,
					};
				}
				ctx.ui.notify(`Goal audit disapproved (attempt ${attempts}/${AUDIT_MAX_RETRIES}). Address the findings and re-verify.`, "warning");
				return {
					content: [{ type: "text", text: `Audit DISAPPROVED. Findings:\n${auditResult.output.slice(0, 1000)}\n\nAddress these and call goal_complete again only when genuinely complete.` }],
					details: { goal, summary } satisfies GoalCompleteDetails, // terminate defaults to false → agent continues in-turn
				};
			}
			// Approved (and shield passed) → fall through to the normal complete transition.
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
	piRef = pi;
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
				case "audit":
					toggleGoalAudit(ctx);
					return;
				case "start":
					await startGoal(result.objective ?? "", result.tokenBudget, pi, ctx, {
						auditEnabled: result.audit,
						auditorModel: result.auditorModel,
					});
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
		stopHeartbeatTimer();
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
		if (!goalState.activeGoal || goalState.activeGoal.status !== "active") return;
		// Task 10: a completed turn is a liveness signal — stamp it BEFORE any
		// early return so the heartbeat stall clock resets on every real turn.
		goalState.lastActivityAt = Date.now();

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
	persistGoal(goalState.extensionApi as ExtensionAPI, goalState.activeGoal);
	updateStatus(ctx, goalState.activeGoal);
	ctx.ui.notify(existingGoal ? `Goal replaced: ${objective}` : `Goal started: ${objective}`, "info");
	await sendGoalPrompt(pi, ctx, goalState.activeGoal);
}

/**
 * `/goal audit` toggle: flip auditEnabled on the active goal. Lets a user opt a
 * goal into (or out of) the completion auditor after it has started. No-op
 * notify when there is no active goal.
 */
function toggleGoalAudit(ctx: StatusContext) {
	if (!goalState.activeGoal) {
		ctx.ui.notify("No active goal.", "info");
		return;
	}
	const next = !goalState.activeGoal.auditEnabled;
	goalState.activeGoal = { ...goalState.activeGoal, auditEnabled: next, updatedAt: Date.now() };
	persistGoal(goalState.extensionApi as ExtensionAPI, goalState.activeGoal);
	updateStatus(ctx, goalState.activeGoal);
	ctx.ui.notify(`Completion audit ${next ? "enabled" : "disabled"} for goal: ${goalState.activeGoal.text}`, "info");
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
		clearPersistedGoal(goalState.extensionApi as ExtensionAPI);
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

function stopHeartbeatTimer() {
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
function syncHeartbeatTimer() {
	const shouldRun = goalState.activeGoal?.status === "active";
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
				void sendContinuationPrompt(piRef!, ctx, goalState.activeGoal!);
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
	syncHeartbeatTimer();
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
	goalState.toolRanThisTurn = false;
	goalState.nudgeCount = 0;
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
// persistGoal / clearPersistedGoal / loadGoalFromSession live in ./persistence.ts
// (deps injected: api / sessionManager passed as params; no module-state reads;
// session-store-only since Task 11 retired the legacy state file) — imported above.

function clearActiveGoal(_ctx: StatusContext) {
	cancelContinuationPending();
	clearGoalRecovery();
	clearStaleGoalToolCallBlock();
	goalState.activeGoal = undefined;
	clearPersistedGoal(goalState.extensionApi as ExtensionAPI);
	goalOverlay?.update(undefined);
	stopStatusRefreshTimer();
	stopHeartbeatTimer();
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
// persistGoal / clearPersistedGoal / loadGoalFromSession live in ./persistence.ts
// (session-store-only) — re-imported above.
