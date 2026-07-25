/**
 * Goal-owned types + pure status-machine functions.
 *
 * Extracted from goal.ts (Phase 1, Task 4) so the state-machine — `createGoal`,
 * `transitionGoal`, `normalizeGoalForBudget`, `incrementGoal`, `cloneGoal`,
 * `isGoal` — is unit-testable in isolation from the UI/coordination seam that
 * remains in goal.ts. This module is pure: it has ZERO @earendil-works/*
 * imports (only the Bun-runtime "crypto" and the local ./format.js sibling).
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
