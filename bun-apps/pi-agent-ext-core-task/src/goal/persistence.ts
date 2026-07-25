/**
 * Goal persistence — session-store only (appendEntry).
 *
 * Extracted from goal.ts (Phase 1, Task 6) so the persistence concern is
 * unit-testable in isolation from the UI/coordination seam that remains in
 * goal.ts. Deps are INJECTED: `api` / `sessionManager` arrive as params — this
 * module reads NO module state, NO `ctx`, and NO files on disk; only its
 * arguments. That keeps it testable without a pi runtime (a fake api +
 * fake sessionManager suffice).
 *
 * The status-machine helpers it needs (`cloneGoal`, `isGoal`) + the `ActiveGoal`
 * type come from ./state.js (Task 4).
 *
 * Legacy file-based state I/O was retired in Task 11; the session store is now
 * the single source of truth for goal persistence + recovery.
 */

import { cloneGoal, isGoal, type ActiveGoal, type GoalStateEntryData } from "./state.js";

// ─── Constants ────────────────────────────────────────────────────────────────

export const GOAL_STATE_ENTRY_TYPE = "goal-state";

/**
 * Minimal slice of ExtensionAPI that persistence needs. Kept local (rather than
 * importing ExtensionAPI from @earendil-works/pi-coding-agent) so this module —
 * and its tests — stay decoupled from pi and trivially fakeable.
 */
export interface GoalPersistenceApi {
	appendEntry: (customType: string, data: unknown) => void;
}

// ─── Session-store persistence ────────────────────────────────────────────────

/**
 * Deep-clone before handing to the session store. The runtime may freeze or
 * canonicalize entry data; without a clone, our live `goalState.activeGoal`
 * reference could be frozen too, after which any `updateGoalUsage(activeGoal)`
 * throws "Attempted to assign to readonly property". The wrapper object is
 * fresh, but the nested `goal` must also be a copy we don't share with the
 * store.
 */
export function persistGoal(api: GoalPersistenceApi | undefined, goal: ActiveGoal): void {
	api?.appendEntry(GOAL_STATE_ENTRY_TYPE, { goal: cloneGoal(goal) });
}

/**
 * Null out the session-store entry (so a reload does not resurrect the goal).
 * Best-effort: a missing api is a no-op.
 */
export function clearPersistedGoal(api: GoalPersistenceApi | undefined): void {
	api?.appendEntry(GOAL_STATE_ENTRY_TYPE, { goal: null });
}

// ─── Goal recovery from the session store ────────────────────────────────────

/**
 * Rehydrate the most recent non-complete goal from the session store, if any.
 * Reads `getBranch()` (preferred) else `getEntries()`. Returns a CLONE so
 * callers may mutate usage fields without aliasing the (possibly frozen) stored
 * reference. `complete` goals and non-goal payloads yield undefined.
 */
export function loadGoalFromSession(sessionManager: unknown): ActiveGoal | undefined {
	const sm = sessionManager as
		| {
				getBranch?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
				getEntries?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
		  }
		| undefined;
	const entries = sm?.getBranch?.() ?? sm?.getEntries?.() ?? [];
	const entry = entries
		.filter((entry) => entry.type === "custom" && entry.customType === GOAL_STATE_ENTRY_TYPE)
		.pop();
	const data = entry?.data as GoalStateEntryData | undefined;
	return isGoal(data?.goal) && data.goal.status !== "complete" ? cloneGoal(data.goal) : undefined;
}
