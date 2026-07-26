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

/**
 * The loop tick — called from goal.ts's agent_end when loopState.active.
 * event shape matches goal.ts's agent_end event: { messages?: unknown[] }.
 */
export async function runLoopTick(pi: ExtensionAPI, ctx: LoopTickCtx, event: { messages?: unknown[] }): Promise<void> {
	if (!loopState.activeLoop?.active) return;
	loopState.lastActivityAt = Date.now();
	const loopId = loopState.activeLoop.id;
	const finalAssistant = findFinalAssistantMessage(event.messages ?? []);

	// iteration + usage (tokens: reuse goal's accounting; fallback 0 if unavailable)
	loopState.activeLoop = { ...loopState.activeLoop, iteration: loopState.activeLoop.iteration + 1 };

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
	ctx.ui.notify(notifyMsg, reason === "error" || reason === "measure-error" ? "error" : "info");
}

async function sendLoopContinuation(pi: ExtensionAPI, ctx: LoopTickCtx): Promise<void> {
	if (!loopState.activeLoop) return;
	if (loopState.continuationPending?.loopId === loopState.activeLoop.id) return;
	if (ctx.hasPendingMessages?.()) return;
	const marker = continuationMarker(loopState.activeLoop);
	const prompt = buildLoopContinuationPrompt(loopState.activeLoop, marker);
	loopState.continuationPending = { loopId: loopState.activeLoop.id, iteration: loopState.activeLoop.iteration, marker, prompt };
	await sendLoopPrompt(pi, ctx, prompt);
}

async function sendLoopPrompt(pi: ExtensionAPI, ctx: LoopTickCtx, prompt: string): Promise<void> {
	try {
		const sent = ctx.isIdle?.() ? (pi.sendUserMessage(prompt) as void | Promise<void>) : (pi.sendUserMessage(prompt, { deliverAs: "followUp" }) as void | Promise<void>);
		await sent;
	} catch { /* best-effort; a failed send surfaces as no continuation -> heartbeat or next turn */ }
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
			loopState.activeLoop = createLoop({ target: parsed.target, mode: parsed.mode, measureCmd: parsed.measureCmd, direction: parsed.direction, maxIterations: parsed.maxIterations, timeLimitMs: parsed.timeLimitMs, tokenBudget: parsed.tokenBudget, plateauWindow: parsed.plateauWindow });
			loopState.extensionApi = pi;
			persistLoop(pi, loopState.activeLoop);
			overlay.update(loopState.activeLoop);
			await sendLoopPrompt(pi, ctx, `Loop started: ${parsed.target} (${parsed.mode}). Begin now.`);
		},
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
