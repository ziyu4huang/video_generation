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
import type { ActiveGoal, GoalStatus } from "./format.js";
export type { ActiveGoal, GoalStatus };

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
}

// ─── Pure status-machine functions ────────────────────────────────────────────

export function createGoal(text: string, tokenBudget: number | undefined, baselineTokens: number): ActiveGoal {
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

/** Runtime, session-scoped goal state. One instance per process (module singleton). */
export interface GoalRuntimeState {
	activeGoal: import("./format.js").ActiveGoal | undefined;
	extensionApi: unknown; // ExtensionAPI — typed loosely to keep state.ts pi-import-free
	continuationPending: ContinuationPending | undefined;
	goalRecovery: GoalRecovery | undefined;
	staleGoalToolCallsBlocked: boolean;
	statusRefreshTimer: ReturnType<typeof setInterval> | undefined;
	latestCtx: unknown; // StatusContext
	cancelledContinuationMarkers: Set<string>;
}

export const goalState: GoalRuntimeState = {
	activeGoal: undefined,
	extensionApi: undefined,
	continuationPending: undefined,
	goalRecovery: undefined,
	staleGoalToolCallsBlocked: false,
	statusRefreshTimer: undefined,
	latestCtx: undefined,
	cancelledContinuationMarkers: new Set<string>(),
};

/** Test seam: reset all runtime state to initial values (mirrors todo/state/store.ts __resetState). */
export function __resetGoalState(): void {
	goalState.activeGoal = undefined;
	goalState.extensionApi = undefined;
	goalState.continuationPending = undefined;
	goalState.goalRecovery = undefined;
	goalState.staleGoalToolCallsBlocked = false;
	goalState.statusRefreshTimer = undefined;
	goalState.latestCtx = undefined;
	goalState.cancelledContinuationMarkers.clear();
}
