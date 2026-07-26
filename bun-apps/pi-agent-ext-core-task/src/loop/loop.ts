/**
 * Loop 3 orchestration: runLoopTick control flow + /loop registration.
 * Branches off goal.ts's agent_end (see T7). Mirrors goal.ts's structure:
 * extract turn -> classify -> measure/metricless -> bounds -> anti-repetition
 * -> continuation. Reuses goal/{overflow,repetition,backoff}.js pure helpers.
 */
import type { ExtensionAPI, ExtensionFactory, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	loopState, createLoop, applyMeasurement, applyMetriclessTick, isBoundedStop, stopLoop,
	cloneLoop, type LoopState, type LoopStopReason,
} from "./loop-state.js";
import { runMeasure } from "./loop-metric.js";
import { parseLoopCommand, completeLoopArguments } from "./loop-commands.js";
import { persistLoop, clearPersistedLoop, loadLoopFromSession } from "./loop-persistence.js";
import type { LoopOverlayLike } from "./overlay.js";
import { findFinalAssistantMessage, isRetryableGoalInterruption, isGoalContextOverflow } from "../goal/overflow.js";
import {
	detectLoopStuck, loopInterventionDirective, pushCapped, textFingerprint, REPETITION, type ToolResultPrint,
} from "../goal/repetition.js";
import {
	backoffMs, shouldPauseAfterBackoff, HEARTBEAT_MAX_NUDGES,
} from "../goal/backoff.js";

export { loopState };

const MEASURE_NULL_STOP = 3;
const HYPOTHESIS_RE = /^HYPOTHESIS:\s*(.*)$/m;

export function parseHypothesis(text: string): string {
	return HYPOTHESIS_RE.exec(text)?.[1]?.trim() ?? "";
}

export function isLoopActive(): boolean { return !!loopState.activeLoop?.active; }

export function buildLoopContinuationPrompt(loop: LoopState, marker: string): string {
	const metricRule = loop.mode === "metric"
		? "\nIMPORTANT: do not report or guess the metric number — the orchestrator runs the measure command and compares it."
		: "";
	return [
		`<!-- pi-loop-continuation:${marker} -->`,
		`Loop iteration ${loop.iteration + 1}. Target: ${loop.target}.`,
		`Begin your reply with a single line: HYPOTHESIS: <the one change you will try this turn>.`,
		`Make exactly ONE concrete, inspectable improvement attempt this turn.${metricRule}`,
	].join("\n");
}

function continuationMarker(loop: LoopState): string {
	return `${loop.id}:${loop.iteration}:${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Continuation-delivery tracking (mirrors goal.ts) ─────────────────────────
// goal.ts clears goalState.continuationPending when the continuation prompt is
// DELIVERED (before_agent_start → markContinuationDelivered). loop.ts had NO
// equivalent, so continuationPending was never cleared between iterations and
// sendLoopContinuation's own guard (`continuationPending?.loopId === ...id`)
// suppressed every continuation after the first → the loop stalled after ~2
// iterations. These helpers + the before_agent_start hook in registerLoop close
// that gap without a goal↔loop import cycle (the marker regex is tiny and
// replicated inline rather than imported from goal.ts).
const LOOP_CONTINUATION_MARKER_PREFIX = "pi-loop-continuation:";
const LOOP_CONTINUATION_MARKER_PATTERN = new RegExp(
	`<!--\\s*${LOOP_CONTINUATION_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\s>]+)\\s*-->`,
);

function extractLoopContinuationMarker(prompt: string): string | undefined {
	return LOOP_CONTINUATION_MARKER_PATTERN.exec(prompt)?.[1];
}

/** Clear loopState.continuationPending when its continuation prompt is delivered. */
function markLoopContinuationDelivered(prompt: string): void {
	const marker = extractLoopContinuationMarker(prompt);
	if (marker && loopState.continuationPending?.marker === marker) loopState.continuationPending = undefined;
}

// Mirrors goal.ts's StatusContext (structural subset) so the agent_end call site
// runLoopTick(pi, ctx, event) type-checks when handed goal.ts's StatusContext.
interface LoopTickCtx {
	cwd: string;
	ui: ExtensionUIContext;
	isIdle?: () => boolean;
	hasPendingMessages?: () => boolean;
	abort?: () => void;
	sessionManager?: unknown;
	// token accounting: goal.ts reads ctx.sessionManager / a token total. Reuse
	// the SAME helper goal.ts uses (currentTokenTotal) — see T7 wiring note.
}

/** Sum assistant usage across the session branch — mirrors goal.ts's currentTokenTotal (T8-final Finding A). */
function currentTokenTotal(ctx: LoopTickCtx): number {
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

/** Zero anti-repetition + measure-failure counters at lifecycle boundaries — mirrors goal.ts's resetHardeningCounters, plus consecutiveMeasureNull (T8-final Finding B). */
function resetLoopHardeningCounters(): void {
	loopState.consecutiveStuck = 0;
	loopState.stuckStartedAt = undefined;
	loopState.recentPrints = [];
	loopState.recentTexts = [];
	loopState.recentToolResults = [];
	loopState.toollessStreak = 0;
	loopState.toolRanThisTurn = false;
	loopState.nudgeCount = 0;
	loopState.consecutiveMeasureNull = 0;
}

/**
 * The loop tick — called from goal.ts's agent_end when loopState.active.
 * event shape matches goal.ts's agent_end event: { messages?: unknown[] }.
 */
export async function runLoopTick(pi: ExtensionAPI, ctx: LoopTickCtx, event: { messages?: unknown[] }): Promise<void> {
	if (!loopState.activeLoop?.active) return;
	loopState.lastActivityAt = Date.now();
	const loopId = loopState.activeLoop.id;
	const finalAssistant = findFinalAssistantMessage(event.messages ?? []);

	// iteration + usage (tokens= bound): reuse goal.ts's currentTokenTotal so the
	// widget's tokensUsed reflects real session usage instead of a frozen 0.
	loopState.activeLoop = {
		...loopState.activeLoop,
		iteration: loopState.activeLoop.iteration + 1,
		tokensUsed: Math.max(0, currentTokenTotal(ctx) - loopState.baselineTokens),
	};

	// Transient error classification (mirrors goal.ts agent_end)
	if (finalAssistant?.stopReason === "aborted" || finalAssistant?.stopReason === "error") {
		if (isRetryableGoalInterruption(finalAssistant)) {
			loopState.loopRecovery = { loopId, kind: isGoalContextOverflow(finalAssistant) ? "compaction_retry" : "provider_retry" };
			persistLoop(loopState.extensionApi as ExtensionAPI, loopState.activeLoop);
			return;
		}
		finishLoop(ctx, "error", `Loop stopped: unrecoverable error.`);
		return;
	}
	loopState.loopRecovery = undefined;

	const assistantText = finalAssistant?.content?.map((c: { text?: string }) => c.text ?? "").join(" ") ?? "";
	const hypothesis = parseHypothesis(assistantText);

	// Metric vs metricless
	if (loopState.activeLoop.mode === "metric" && loopState.activeLoop.measureCmd) {
		const value = await runMeasure(pi as unknown as { exec: (p: string, a: string[], o: { cwd: string; timeout: number }) => Promise<{ stdout?: string; exitCode?: number }> }, loopState.activeLoop.measureCmd, ctx.cwd);
		if (value === null) {
			loopState.consecutiveMeasureNull += 1;
			if (loopState.consecutiveMeasureNull >= MEASURE_NULL_STOP) { finishLoop(ctx, "measure-error", `Loop stopped: measure command failed ${loopState.consecutiveMeasureNull}× in a row.`); return; }
			loopState.activeLoop = applyMetriclessTick(loopState.activeLoop, hypothesis || "(no measure value)");
		} else {
			loopState.consecutiveMeasureNull = 0;
			loopState.activeLoop = applyMeasurement(loopState.activeLoop, value, hypothesis || "(no hypothesis)");
		}
	} else {
		loopState.activeLoop = applyMetriclessTick(loopState.activeLoop, hypothesis || "(no hypothesis)");
	}

	// Bounds
	const bound = isBoundedStop(loopState.activeLoop);
	if (bound) { finishLoop(ctx, bound, stopMessage(bound)); return; }

	// Anti-repetition (mirror goal.ts: fingerprint, classify, intervene)
	const toolRanThisTurn = loopState.toolRanThisTurn;
	loopState.toolRanThisTurn = false;
	loopState.toollessStreak = toolRanThisTurn ? 0 : loopState.toollessStreak + 1;
	loopState.nudgeCount = toolRanThisTurn ? 0 : loopState.nudgeCount + 1;
	if (loopState.nudgeCount >= HEARTBEAT_MAX_NUDGES) { finishLoop(ctx, "repetition", `Loop stopped: 3 consecutive no-tool turns.`); return; }

	const print = textFingerprint(assistantText);
	loopState.recentPrints = pushCapped(loopState.recentPrints, print, REPETITION.printWindow);
	loopState.recentTexts = pushCapped(loopState.recentTexts, assistantText.slice(0, 1000), REPETITION.textWindow);
	const reason = detectLoopStuck({ assistantText, recentPrints: loopState.recentPrints, previousText: loopState.recentTexts[loopState.recentTexts.length - 2], recentToolResults: loopState.recentToolResults, toollessStreak: loopState.toollessStreak });
	if (reason) {
		loopState.consecutiveStuck += 1;
		if (loopState.stuckStartedAt === undefined) loopState.stuckStartedAt = Date.now();
		if (loopState.consecutiveStuck >= REPETITION.maxInterventions) { finishLoop(ctx, "repetition", `Loop stopped: stuck ${loopState.consecutiveStuck} iterations (${reason}).`); return; }
		if (shouldPauseAfterBackoff(Date.now() - loopState.stuckStartedAt!, loopState.toollessStreak)) { finishLoop(ctx, "repetition", `Loop stopped: backoff cap (${reason}).`); return; }
		await sendLoopPrompt(pi, ctx, loopInterventionDirective(loopState.consecutiveStuck, reason, loopState.recentTexts));
		return;
	}
	loopState.consecutiveStuck = 0; loopState.stuckStartedAt = undefined;

	persistLoop(loopState.extensionApi as ExtensionAPI, loopState.activeLoop);
	const wait = backoffMs(0);
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	await sendLoopContinuation(pi, ctx);
}

function stopMessage(reason: LoopStopReason): string { return `Loop stopped: ${reason}.`; }

function finishLoop(ctx: LoopTickCtx, reason: LoopStopReason, notifyMsg: string): void {
	if (loopState.activeLoop) {
		loopState.activeLoop = stopLoop(loopState.activeLoop, reason);
		loopState.activeLoop.history = pushCapped(loopState.activeLoop.history, { iteration: loopState.activeLoop.iteration, at: Date.now(), hypothesis: "(stop)", verdict: "metricless" }, 50);
	}
	clearPersistedLoop(loopState.extensionApi as ExtensionAPI);
	loopState.activeLoop = undefined;
	loopState.continuationPending = undefined;
	// Reset anti-repetition/measure counters so a later /loop start (same session)
	// does not inherit this loop's dirty state (T8-final Finding B).
	resetLoopHardeningCounters();
	// Re-evaluate the heartbeat: with no loop (and typically no goal) active,
	// syncHeartbeatTimer's shouldRun flips false and the interval is torn down.
	// No-op if goal() was never registered (seam undefined).
	((globalThis as Record<string, unknown>).__piKickHeartbeat as (() => void) | undefined)?.();
	ctx.ui.notify(notifyMsg, reason === "error" || reason === "measure-error" ? "error" : "info");
}

async function sendLoopContinuation(pi: ExtensionAPI, ctx: LoopTickCtx): Promise<void> {
	if (!loopState.activeLoop) return;
	if (loopState.continuationPending?.loopId === loopState.activeLoop.id) return;
	if (ctx.hasPendingMessages?.()) return;
	const marker = continuationMarker(loopState.activeLoop);
	const prompt = buildLoopContinuationPrompt(loopState.activeLoop, marker);
	loopState.continuationPending = { loopId: loopState.activeLoop.id, iteration: loopState.activeLoop.iteration, marker, prompt };
	const delivered = await sendLoopPrompt(pi, ctx, prompt);
	if (!delivered) {
		// Spec §8: a continuation send failure must stop the loop (never silently
		// hang — continuationPending is set above, which would block both the next
		// sendLoopContinuation and the heartbeat's refireLoopContinuation).
		finishLoop(ctx, "error", "Loop stopped: continuation delivery failed.");
	}
}

/** Heartbeat re-fire entry — called by goal.ts's generalized heartbeat when a loop is active + idle + stalled. */
export async function refireLoopContinuation(pi: ExtensionAPI, ctx: LoopTickCtx): Promise<void> {
	if (!isLoopActive()) return;
	if (loopState.continuationPending) return;
	await sendLoopContinuation(pi, ctx);
}

/** Send a prompt; returns true on success, false if the send threw (T8-final Finding C). */
async function sendLoopPrompt(pi: ExtensionAPI, ctx: LoopTickCtx, prompt: string): Promise<boolean> {
	try {
		const sent = ctx.isIdle?.() ? (pi.sendUserMessage(prompt) as void | Promise<void>) : (pi.sendUserMessage(prompt, { deliverAs: "followUp" }) as void | Promise<void>);
		await sent;
		return true;
	} catch {
		// Best-effort: callers that treat a failed send as fatal (sendLoopContinuation)
		// check the boolean; other callers ignore it.
		return false;
	}
}

// ─── /loop command + registration ────────────────────────────────────────────

export function registerLoop(pi: ExtensionAPI, overlay: LoopOverlayLike): void {
	pi.registerCommand("loop", {
		description: "Run a process loop: /loop [start \"<target>\" measure=<cmd> ... | stop | status]",
		getArgumentCompletions: completeLoopArguments,
		handler: async (args: string, ctx: LoopTickCtx) => {
			const parsed = parseLoopCommand(args ?? "");
			if (typeof parsed === "string") { ctx.ui.notify(parsed, "warning"); return; }
			if (parsed.kind === "show") { ctx.ui.notify(showLoopText(), "info"); return; }
			if (parsed.kind === "stop") {
				if (!loopState.activeLoop) { ctx.ui.notify("No active loop.", "info"); return; }
				finishLoop(ctx, "user", "Loop stopped by user.");
				overlay.update(undefined);
				return;
			}
			// start
			if (loopState.activeLoop) { ctx.ui.notify("A loop is already active. Run /loop stop first.", "warning"); return; }
			// mutual exclusion with goal is enforced in goal.ts (T7) via isGoalActive();
			// double-check the globalThis seam here too:
			const goalActive = (globalThis as Record<string, unknown>).__piGoalActive;
			if (typeof goalActive === "function" && goalActive() === true) {
				ctx.ui.notify("A goal is active. Run /goal clear or complete it before starting a loop.", "warning"); return;
			}
			resetLoopHardeningCounters();
			loopState.activeLoop = createLoop({ target: parsed.target, mode: parsed.mode, measureCmd: parsed.measureCmd, direction: parsed.direction, maxIterations: parsed.maxIterations, timeLimitMs: parsed.timeLimitMs, tokenBudget: parsed.tokenBudget, plateauWindow: parsed.plateauWindow });
			loopState.extensionApi = pi;
			loopState.baselineTokens = currentTokenTotal(ctx);
			persistLoop(pi, loopState.activeLoop);
			overlay.update(loopState.activeLoop);
			// Arm the heartbeat supervision for the loop (goal XOR loop): now that
			// loopState.activeLoop is set, syncHeartbeatTimer's shouldRun is true and
			// the interval starts. No-op if goal() was never registered (seam undefined).
			((globalThis as Record<string, unknown>).__piKickHeartbeat as (() => void) | undefined)?.();
			await sendLoopPrompt(pi, ctx, `Loop started: ${parsed.target} (${parsed.mode}). Begin now.`);
		},
	});

	// Mirror goal.ts's before_agent_start → markContinuationDelivered: when the
	// delivered prompt carries THIS loop's continuation marker, clear
	// loopState.continuationPending so the next agent_end can send a fresh
	// continuation. Without this, continuationPending is set by sendLoopContinuation
	// and never cleared on delivery, so sendLoopContinuation's own guard suppresses
	// every continuation after the first and the loop stalls after ~2 iterations.
	// (Registered here — not in goal.ts — to avoid a goal↔loop import cycle; the
	// loop uses a distinct `pi-loop-continuation:` marker that goal's extractor does
	// not match, so the two hooks coexist without interference.)
	pi.on("before_agent_start", (event: { systemPrompt?: string; prompt?: string }) => {
		if (event.prompt) markLoopContinuationDelivered(event.prompt);
	});
}

function showLoopText(): string {
	const l = loopState.activeLoop;
	if (!l) return "No active loop.";
	const best = l.bestValue !== undefined ? ` best=${l.bestValue}` : "";
	return `⟳ loop #${l.iteration + 1} (${l.mode})${best} stall=${l.stallCount}/${l.plateauWindow}`;
}

/** Called by core-task.ts session_start/session_compact to recover an active loop. */
export function restoreLoopFromSession(sessionManager: unknown, overlay: LoopOverlayLike): void {
	const loop = loadLoopFromSession(sessionManager);
	if (loop) { loopState.activeLoop = loop; overlay.update(loop); }
}
