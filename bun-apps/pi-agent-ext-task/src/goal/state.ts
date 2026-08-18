/**
 * Goal-owned types + pure status-machine functions + the runtime-state
 * container.
 *
 * Extracted from goal.ts (Phase 1, Task 4) so the state-machine — `createGoal`,
 * `transitionGoal`, `normalizeGoalForBudget`, `incrementGoal`, `cloneGoal`,
 * `isGoal` — is unit-testable in isolation from the UI/coordination seam that
 * remains in goal.ts. The status-machine functions are pure. The
 * `GoalRuntimeState` container (Phase 1, Task 5) centralizes goal.ts's
 * session-scoped mutable `let`s behind one object so they can be reset from
 * tests via `__resetGoalState()`. This module STILL has ZERO
 * @earendil-works/* imports (only the Bun-runtime "crypto" and the local
 * ./format.js sibling); that is why `extensionApi` / `latestCtx` are typed
 * `unknown` and narrowed at read sites in goal.ts.
 *
 * Status machine:
 *   active ← → paused
 *   active → budget_limited (tokensUsed >= tokenBudget)
 *   active → complete (via goal_complete tool)
 *   paused → active (via /goal resume)
 *   budget_limited → active (via /goal resume, if budget allows)
 *   any → cleared (via /goal clear)
 */

import { randomUUID } from "crypto";
import type { ActiveGoal, GoalAuditOptions, GoalStatus, GoalListItem } from "./format.js";
import type { ToolResultPrint } from "./repetition.js";
export type { ActiveGoal, GoalStatus };
export type { GoalAuditOptions, GoalListItem };

// ─── Goal-specific types ──────────────────────────────────────────────────────

export interface GoalCompleteDetails {
	goal: string;
	summary: string;
}

export interface ContinuationPending {
	goalId: string;
	iteration: number;
	marker: string;
	prompt: string;
}

export type GoalRecoveryKind = "provider_retry" | "compaction_retry";

export interface GoalRecovery {
	goalId: string;
	kind: GoalRecoveryKind;
}

export interface GoalStateEntryData {
	goal?: ActiveGoal | null;
	list?: GoalListItem[]; // Loop 2 (D2): the queue tail, persisted per session.
}

// ─── Pure status-machine functions ────────────────────────────────────────────

export function createGoal(
	text: string,
	tokenBudget: number | undefined,
	baselineTokens: number,
	audit?: GoalAuditOptions,
	origin: "list" | "bare" = "bare",
): ActiveGoal {
	const now = Date.now();
	return {
		id: randomUUID(),
		text,
		origin,
		status: "active",
		startedAt: now,
		updatedAt: now,
		iteration: 0,
		tokenBudget,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		baselineTokens,
		auditEnabled: audit?.auditEnabled,
		auditorModel: audit?.auditorModel,
		verificationContract: audit?.verificationContract,
	};
}

// Issue #1616: conservative default so every goal is bounded even when created
// without --tokens; raise explicitly via /goal --tokens for large efforts.
export const DEFAULT_GOAL_TOKEN_BUDGET = 500_000;

export function applyDefaultTokenBudget(goal: ActiveGoal): void {
	if (goal.tokenBudget === undefined) goal.tokenBudget = DEFAULT_GOAL_TOKEN_BUDGET;
}

export function transitionGoal(goal: ActiveGoal, status: GoalStatus): ActiveGoal {
	return normalizeGoalForBudget({ ...goal, status, updatedAt: Date.now() });
}

export function editedGoalStatus(status: GoalStatus): GoalStatus {
	return status === "paused" ? "paused" : "active";
}

export function normalizeGoalForBudget(goal: ActiveGoal): ActiveGoal {
	if (
		goal.status === "active" &&
		goal.tokenBudget !== undefined &&
		goal.tokensUsed >= goal.tokenBudget
	) {
		return { ...goal, status: "budget_limited" };
	}
	return goal;
}

export function incrementGoal(goal: ActiveGoal): ActiveGoal {
	return { ...goal, iteration: goal.iteration + 1, updatedAt: Date.now() };
}

// Clone a goal so callers never mutate the session store's (possibly frozen)
// canonical reference. structuredClone keeps the plain-JSON shape of ActiveGoal.
export function cloneGoal(goal: ActiveGoal): ActiveGoal {
	try {
		return structuredClone(goal);
	} catch {
		// Fallback for environments without structuredClone — ActiveGoal is plain data.
		return JSON.parse(JSON.stringify(goal)) as ActiveGoal;
	}
}

export function isGoal(value: unknown): value is ActiveGoal {
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

// ─── Runtime-state container + test seam (Phase 1, Task 5) ────────────────────
// Centralizes goal.ts's session-scoped mutable `let`s behind one object so the
// pure status-machine above stays pure while the coordination/UI seam in goal.ts
// reads/writes a single named container. `__resetGoalState()` mirrors
// todo/state/store.ts __resetState and lets tests start from a known baseline.

/** Runtime, session-scoped goal state. One instance per process (module singleton).
 *
 * CAVEAT: in-process subagents share this singleton — see ticket #16.
 */
export interface GoalRuntimeState {
	activeGoal: import("./format.js").ActiveGoal | undefined;
	extensionApi: unknown; // ExtensionAPI — typed loosely to keep state.ts pi-import-free
	// The status widget. Lives here rather than as a module-level binding in
	// goal.ts because the goal.ts split (spec 1a) gave lifecycle, timers and the
	// hook handlers each their own module, and all four update the overlay — a
	// module-level `let` in the facade would have had to be exported and written
	// from four files. The type is an inline `import(...)` like `activeGoal`
	// above, so state.ts stays free of @earendil-works/* import statements.
	overlay: import("./overlay.js").GoalOverlayLike | undefined;
	continuationPending: ContinuationPending | undefined;
	goalRecovery: GoalRecovery | undefined;
	staleGoalToolCallsBlocked: boolean;
	statusRefreshTimer: ReturnType<typeof setInterval> | undefined;
	latestCtx: unknown; // StatusContext
	cancelledContinuationMarkers: Set<string>;
	// Phase-2 hardening (Task 9): anti-repetition rolling windows + backoff cap.
	// recentPrints/recentTexts/recentToolResults are the classifier inputs;
	// consecutiveStuck/stuckStartedAt drive the intervention rotation + caps;
	// toollessStreak counts consecutive tool-less turns (narration-only loops).
	// toolRanThisTurn is a per-turn flag set by tool_execution_end and consumed
	// (and cleared) by agent_end so toollessStreak only increments on a turn
	// that genuinely had no tool call. Without it the streak is off-by-one:
	// every turn ends at streak >= 1, so the FIRST narration turn after a tool
	// turn already trips the 2-iteration stuck threshold.
	consecutiveStuck: number;
	stuckStartedAt: number | undefined;
	recentPrints: string[];
	recentTexts: string[];
	recentToolResults: ToolResultPrint[];
	toollessStreak: number;
	toolRanThisTurn: boolean;
	// Phase-2 hardening (Task 10): heartbeat self-watchdog + wedge alert.
	// heartbeatTimer ticks every HEARTBEAT_INTERVAL_MS while a goal is active;
	// lastActivityAt is stamped on tool_execution_end / agent_end / input so the
	// watchdog can detect a stalled session (compaction-eaten turn, dropped
	// message) and re-fire the continuation; lastWedgeAlertAt throttles the
	// "no activity for 30m" wedge notify to once per threshold; nudgeCount tracks
	// consecutive no-tool turns (>= HEARTBEAT_MAX_NUDGES -> pause). All primitives /
	// timer refs so state.ts stays pi-import-free (Task 5 constraint).
	heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	lastActivityAt: number;
	lastWedgeAlertAt: number;
	nudgeCount: number;
	// Loop 2 (D2): the /list goal queue. `list` is the tail of pending items
	// (goal-to-bes with no status/usage); `headAdvances` counts how many heads
	// have been promoted so far — it drives the widget position so a re-promoted
	// list shows "advancing" rather than "reset". Both reset on __resetGoalState.
	list: GoalListItem[];
	headAdvances: number;
	// Reviewer wiring (Task 3): global enable toggle for the Reviewer. Driven by
	// `/goal review on|off|auto|aggressive` (Task 6). Default true/on (Reviewer active by default).
	reviewerEnabled: boolean;
	reviewerMode: import("./reviewer.js").ReviewerMode;
}

export const goalState: GoalRuntimeState = {
	activeGoal: undefined,
	extensionApi: undefined,
	overlay: undefined,
	continuationPending: undefined,
	goalRecovery: undefined,
	staleGoalToolCallsBlocked: false,
	statusRefreshTimer: undefined,
	latestCtx: undefined,
	cancelledContinuationMarkers: new Set<string>(),
	consecutiveStuck: 0,
	stuckStartedAt: undefined,
	recentPrints: [],
	recentTexts: [],
	recentToolResults: [],
	toollessStreak: 0,
	toolRanThisTurn: false,
	heartbeatTimer: undefined,
	lastActivityAt: Date.now(),
	lastWedgeAlertAt: 0,
	nudgeCount: 0,
	list: [],
	headAdvances: 0,
	reviewerEnabled: true,
	reviewerMode: "on",
};

/** Test seam: reset all runtime state to initial values (mirrors todo/state/store.ts __resetState). */
export function __resetGoalState(): void {
	goalState.activeGoal = undefined;
	goalState.extensionApi = undefined;
	goalState.overlay = undefined;
	goalState.continuationPending = undefined;
	goalState.goalRecovery = undefined;
	goalState.staleGoalToolCallsBlocked = false;
	goalState.statusRefreshTimer = undefined;
	goalState.latestCtx = undefined;
	goalState.cancelledContinuationMarkers.clear();
	goalState.consecutiveStuck = 0;
	goalState.stuckStartedAt = undefined;
	goalState.recentPrints = [];
	goalState.recentTexts = [];
	goalState.recentToolResults = [];
	goalState.toollessStreak = 0;
	goalState.toolRanThisTurn = false;
	goalState.heartbeatTimer = undefined;
	goalState.lastActivityAt = Date.now();
	goalState.lastWedgeAlertAt = 0;
	goalState.nudgeCount = 0;
	goalState.list = [];
	goalState.headAdvances = 0;
	goalState.reviewerEnabled = true;
	goalState.reviewerMode = "on";
}
