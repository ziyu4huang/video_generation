/**
 * Loop 3 — process-loop state. Pure model + runtime singleton.
 * Zero @earendil-works/* imports (mirror goal/state.ts) so it is unit-testable
 * under plain bun. The orchestration/coordination seam lives in loop.ts.
 */
import { randomUUID } from "node:crypto";
import { pushCapped, type ToolResultPrint } from "../goal/repetition.js";

export type LoopMode = "metric" | "metricless";
export type LoopVerdict = "improved" | "plateau" | "regressed" | "metricless";
export type LoopStopReason = "user" | "max" | "time" | "tokens" | "plateau" | "measure-error" | "repetition" | "error";
export type LoopDirection = "higher" | "lower";

export interface LoopMeasure {
	iteration: number;
	at: number;
	value?: number;
	hypothesis: string;
	verdict: LoopVerdict;
}

export interface LoopState {
	id: string;
	target: string;
	mode: LoopMode;
	measureCmd?: string;
	direction: LoopDirection;
	iteration: number;
	maxIterations: number;
	timeLimitMs?: number;
	tokenBudget?: number;
	tokensUsed: number;
	bestValue?: number;
	lastValue?: number;
	plateauWindow: number;
	stallCount: number;
	history: LoopMeasure[];
	startedAt: number;
	active: boolean;
	stopReason?: LoopStopReason;
}

export const HISTORY_CAP = 50;
export const DEFAULT_PLATEAU_WINDOW = 5;

export interface CreateLoopArgs {
	target: string;
	mode: LoopMode;
	measureCmd?: string;
	direction?: LoopDirection;
	maxIterations?: number;
	timeLimitMs?: number;
	tokenBudget?: number;
	plateauWindow?: number;
}

export function createLoop(args: CreateLoopArgs): LoopState {
	const now = Date.now();
	return {
		id: randomUUID(),
		target: args.target,
		mode: args.mode,
		measureCmd: args.measureCmd,
		direction: args.direction ?? "higher",
		iteration: 0,
		maxIterations: args.maxIterations ?? 0,
		timeLimitMs: args.timeLimitMs,
		tokenBudget: args.tokenBudget,
		tokensUsed: 0,
		plateauWindow: args.plateauWindow ?? DEFAULT_PLATEAU_WINDOW,
		stallCount: 0,
		history: [],
		startedAt: now,
		active: true,
	};
}

function isBetter(newValue: number, best: number | undefined, direction: LoopDirection): boolean {
	if (best === undefined) return true; // first reading is the baseline
	return direction === "higher" ? newValue > best : newValue < best;
}

/** Apply a metric reading. First reading is the baseline (improved, no stall). */
export function applyMeasurement(loop: LoopState, value: number, hypothesis: string): LoopState {
	const improved = isBetter(value, loop.bestValue, loop.direction);
	const verdict: LoopVerdict = improved ? "improved" : value === loop.bestValue ? "plateau" : "regressed";
	const entry: LoopMeasure = { iteration: loop.iteration, at: Date.now(), value, hypothesis, verdict };
	return {
		...loop,
		bestValue: improved ? value : loop.bestValue,
		lastValue: value,
		stallCount: improved ? 0 : loop.stallCount + 1,
		history: pushCapped(loop.history, entry, HISTORY_CAP),
	};
}

export function applyMetriclessTick(loop: LoopState, hypothesis: string): LoopState {
	const entry: LoopMeasure = { iteration: loop.iteration, at: Date.now(), hypothesis, verdict: "metricless" };
	return { ...loop, history: pushCapped(loop.history, entry, HISTORY_CAP) };
}

/** Returns the first bound hit (priority: max, time, tokens, plateau) or undefined. */
export function isBoundedStop(loop: LoopState): LoopStopReason | undefined {
	if (loop.maxIterations > 0 && loop.iteration >= loop.maxIterations) return "max";
	if (loop.timeLimitMs !== undefined && Date.now() - loop.startedAt >= loop.timeLimitMs) return "time";
	if (loop.tokenBudget !== undefined && loop.tokensUsed >= loop.tokenBudget) return "tokens";
	if (loop.mode === "metric" && loop.stallCount >= loop.plateauWindow) return "plateau";
	return undefined;
}

export function stopLoop(loop: LoopState, reason: LoopStopReason): LoopState {
	return { ...loop, active: false, stopReason: reason };
}

export function cloneLoop(loop: LoopState): LoopState {
	try { return structuredClone(loop); } catch { return JSON.parse(JSON.stringify(loop)) as LoopState; }
}

export function isLoop(v: unknown): v is LoopState {
	if (!v || typeof v !== "object") return false;
	const l = v as Partial<LoopState>;
	return typeof l.id === "string" && typeof l.target === "string" &&
		(l.mode === "metric" || l.mode === "metricless") && typeof l.iteration === "number" &&
		typeof l.startedAt === "number" && typeof l.active === "boolean";
}

// ─── Runtime singleton (mirrors goal/state.ts GoalRuntimeState) ──────────────

export interface ContinuationPending { loopId: string; iteration: number; marker: string; prompt: string; }
export type LoopRecoveryKind = "provider_retry" | "compaction_retry";
export interface LoopRecovery { loopId: string; kind: LoopRecoveryKind; }

export interface LoopRuntimeState {
	activeLoop: LoopState | undefined;
	extensionApi: unknown; // ExtensionAPI — typed loosely to stay pi-import-free
	continuationPending: ContinuationPending | undefined;
	loopRecovery: LoopRecovery | undefined;
	baselineTokens: number; // token baseline for the tokens= bound (T8-final Finding A)
	// Anti-repetition windows (reused REPETITION constants via repetition.js)
	consecutiveStuck: number;
	stuckStartedAt: number | undefined;
	recentPrints: string[];
	recentTexts: string[];
	recentToolResults: ToolResultPrint[];
	toollessStreak: number;
	toolRanThisTurn: boolean;
	// Liveness (reused backoff.js predicates)
	lastActivityAt: number;
	lastWedgeAlertAt: number;
	nudgeCount: number;
	// Measure-failure tracking (§7: ≥3 consecutive null -> stop)
	consecutiveMeasureNull: number;
}

// ─── Per-sessionId runtime state (optimization #3, ticket #16) ───────────────
// loopState was a process-global mutable singleton read/written directly at ~70
// sites in loop.ts. Key it by sessionId so an in-process subagent child driving
// the loop machinery does NOT mutate the parent's loop runtime state (the same
// ticket-#16 defect as the todo store). Mirrors todo/state/store.ts: no-arg
// getLoopState() defaults to a module-captured `renderSid` (the parent/display
// session id, set at session_start via setLoopRenderSid) so ctx-less/display
// sites read the parent's bucket unchanged; ctx-bearing sites thread the real
// ctx.sessionManager.getSessionId(). loopState owns NO timer (it borrows goal's
// heartbeat), so this is clean mechanical keying — no interval-teardown seam.
const DEFAULT_SID = "";
let renderSid: string = DEFAULT_SID;
const states = new Map<string, LoopRuntimeState>();

function freshState(): LoopRuntimeState {
	return {
		activeLoop: undefined, extensionApi: undefined, continuationPending: undefined, loopRecovery: undefined,
		baselineTokens: 0,
		consecutiveStuck: 0, stuckStartedAt: undefined, recentPrints: [], recentTexts: [], recentToolResults: [],
		toollessStreak: 0, toolRanThisTurn: false, lastActivityAt: Date.now(), lastWedgeAlertAt: 0, nudgeCount: 0,
		consecutiveMeasureNull: 0,
	};
}

function bucket(sid?: string): LoopRuntimeState {
	const key = sid ?? renderSid; // no-arg → display (parent) bucket
	let s = states.get(key);
	if (!s) { s = freshState(); states.set(key, s); }
	return s;
}

/** Capture the parent/display session id at session_start. No-arg getLoopState()
 *  falls back to this bucket so ctx-less/display sites read the parent's loop
 *  state. (Namespaced setLoopRenderSid — todo already owns setRenderSid.) */
export function setLoopRenderSid(sid: string): void {
	renderSid = sid;
}

export function getLoopState(sid?: string): LoopRuntimeState {
	return bucket(sid);
}

/** Test seam + session_shutdown cleanup. No-arg: clear ALL buckets + reset
 *  renderSid (test clear-all). With an explicit sid: delete that single bucket
 *  (per-session teardown). */
export function __resetLoopState(sid?: string): void {
	if (sid === undefined) { states.clear(); renderSid = DEFAULT_SID; }
	else states.delete(sid);
}
