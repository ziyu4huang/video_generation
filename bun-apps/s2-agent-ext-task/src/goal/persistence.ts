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

import {
	cloneGoal,
	goalState,
	isGoal,
	type ActiveGoal,
	type GoalListItem,
	type GoalStateEntryData,
} from "./state.js";

// ─── Constants ────────────────────────────────────────────────────────────────

export const GOAL_STATE_ENTRY_TYPE = "goal-state";
export const REVIEWER_ENTRY_TYPE = "goal-reviewer";

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
 * Persist the active goal (head) AND the current /list tail (`goalState.list`)
 * in one session-store entry. Delegates to `persistGoalState` so every persist
 * site — including the ~19 existing `persistGoal(api, goal)` call sites in
 * goal.ts — carries the tail, and a compaction/restart recovers both atomically.
 *
 * NOTE: this deliberately reads `goalState.list` (module state) — a relaxation
 * of the Phase-1 "no module state" note at the top of this file. `goalState` is
 * a pi-free plain singleton (state.ts imports zero @earendil-works/* modules),
 * so testability-without-a-pi-runtime is preserved: a test sets
 * `goalState.list` directly, then calls `persistGoal(api, goal)`. The injected
 * `api` remains the only seam that touches the runtime.
 */
export function persistGoal(api: GoalPersistenceApi | undefined, goal: ActiveGoal): void {
	persistGoalState(api, goal, goalState.list);
}

/**
 * Null out the session-store entry (so a reload does not resurrect the goal)
 * AND clear the /list tail — writes `{ goal: null, list: [] }`. Best-effort:
 * a missing api is a no-op.
 */
export function clearPersistedGoal(api: GoalPersistenceApi | undefined): void {
	persistGoalState(api, null, []);
}

// ─── Session-store persistence — head + tail (Loop 2, Task 3 / D2) ────────────
//
// `persistGoalState` is the single writer since Task 5a: it carries the active
// goal (head) AND the /list queue tail in ONE session-store entry, so a reload
// restores both atomically. `persistGoal` / `clearPersistedGoal` (above) are
// thin delegating wrappers over it — kept so the ~19 existing `persistGoal(api,
// goal)` call sites in goal.ts carry the tail without per-site edits.

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
//
// `loadGoalStateFromSession` is the sole recovery loader since Task 5a
// (the legacy head-only loader was deleted — its two callers in goal.ts were
// migrated to `loadGoalStateFromSession`, which restores both the head AND the
// tail in one read).

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

// ─── Reviewer ledger persistence (Task 4) ─────────────────────────────────────

/**
 * Shape of a reviewer ledger entry written to the session store. Records
 * reviewer fires (cascade enqueues) and suppressions (e.g., refire-window).
 */
export interface ReviewerLedgerRecord {
	type: "reviewer_fired" | "reviewer_suppressed";
	at: string;
	goalId: string;
	/** For reviewer_fired: which cascade step enqueued tasks */
	cascadeStep?: string;
	/** For reviewer_fired: count of enqueued tasks */
	enqueued?: number;
	/** For reviewer_fired: count of proposed tasks */
	proposed?: number;
	/** For reviewer_suppressed: why the reviewer did not fire */
	reason?: string;
}

/**
 * Append a reviewer ledger entry to the session store. Best-effort: a missing
 * api is a no-op.
 */
export function appendReviewerEntry(
	api: GoalPersistenceApi | undefined,
	record: ReviewerLedgerRecord,
): void {
	api?.appendEntry(REVIEWER_ENTRY_TYPE, record);
}

/**
 * Load all reviewer ledger entries from the session store. Returns an array of
 * records (chronological, oldest first), filtering by entry type. Returns an
 * empty array when sessionManager is undefined or has no readers.
 */
export function loadReviewerEntries(sessionManager: unknown): ReviewerLedgerRecord[] {
	const sm = sessionManager as {
		getBranch?: () => Array<{ type: string; customType?: string; data: unknown }>;
		getEntries?: () => Array<{ type: string; customType?: string; data: unknown }>;
	} | undefined;
	const entries = sm?.getBranch?.() ?? sm?.getEntries?.() ?? [];
	return entries
		.filter((e) => e.type === "custom" && e.customType === REVIEWER_ENTRY_TYPE)
		.map((e) => e.data as ReviewerLedgerRecord);
}

// Issue #1616: the running loop is memory-resident; the journal's last explicit
// verdict for the SAME goal outranks the in-memory snapshot (which the driver
// re-stamps itself). True = skip the refire and defer to the persisted status.
export function shouldHonorPersistedStatus(
	current: { id: string; status: string } | null | undefined,
	persisted: { id: string; status: string } | null | undefined,
): boolean {
	if (!persisted?.id || !current) return false;
	if (persisted.id !== current.id) return false;
	return persisted.status !== "active";
}
