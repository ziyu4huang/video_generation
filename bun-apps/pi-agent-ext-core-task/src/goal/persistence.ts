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

import { cloneGoal, isGoal, type ActiveGoal, type GoalListItem, type GoalStateEntryData } from "./state.js";

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

// ─── Session-store persistence — head + tail (Loop 2, Task 3 / D2) ────────────
//
// `persistGoalState` carries the active goal (head) AND the /list queue tail in
// ONE session-store entry, so a reload restores both atomically. The legacy
// `persistGoal`/`clearPersistedGoal` (head-only) remain for callers Task 5 has
// not migrated yet — these new functions COEXIST, they do not replace them.

/**
 * Persist the active goal (head) + the /list queue tail in one session-store
 * entry. The goal is deep-cloned (`cloneGoal`) and each list item is shallow-
 * cloned (`{...item}`) so the store never holds a live, mutable reference —
 * the runtime may freeze/canonicalize entry data, after which mutating the
 * shared goal/list would throw. Null goal (e.g. between heads) still persists
 * the list. Best-effort: a missing api is a no-op.
 */
export function persistGoalState(
	api: GoalPersistenceApi | undefined,
	goal: ActiveGoal | null,
	list: GoalListItem[],
): void {
	api?.appendEntry(GOAL_STATE_ENTRY_TYPE, {
		goal: goal ? cloneGoal(goal) : null,
		list: list.map((item) => ({ ...item })),
	});
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

/**
 * Rehydrate the most recent non-complete goal (head) AND its /list queue tail
 * from the same session-store entry written by `persistGoalState`. Reads
 * `getBranch()` (preferred) else `getEntries()`; the LAST goal-state entry wins
 * (most recent). The goal is returned ONLY when it is a real goal and not
 * `complete`; the list is ALWAYS recovered from that entry (a completed head
 * should not resurrect, but its tail may still hold pending items). Both are
 * returned as CLONEs so callers may mutate usage fields / reorder the list
 * without aliasing the (possibly frozen) stored reference.
 */
export function loadGoalStateFromSession(sessionManager: unknown): {
	goal?: ActiveGoal;
	list?: GoalListItem[];
} {
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
	const goal =
		isGoal(data?.goal) && data.goal.status !== "complete" ? cloneGoal(data.goal) : undefined;
	return { goal, list: data?.list?.map((item) => ({ ...item })) };
}
