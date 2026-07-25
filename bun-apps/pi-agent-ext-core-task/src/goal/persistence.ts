/**
 * Goal persistence — session-store writes (appendEntry) + the legacy
 * pi-goal-state.json fallback.
 *
 * Extracted from goal.ts (Phase 1, Task 6) so the persistence concern is
 * unit-testable in isolation from the UI/coordination seam that remains in
 * goal.ts. Deps are INJECTED: `api` / `sessionManager` arrive as params — this
 * module reads NO module state and NO `ctx`, only its arguments plus the legacy
 * file on disk. That keeps it testable without a pi runtime (a fake api +
 * fake sessionManager suffice).
 *
 * The status-machine helpers it needs (`cloneGoal`, `isGoal`) + the `ActiveGoal`
 * type come from ./state.js (Task 4). The legacy JSON is intentionally NOT
 * removed here — it is retired in Task 11; this task only MOVES it, verbatim.
 *
 * Zero behavior change vs the previous in-goal.ts implementations: only the
 * `api` / `sessionManager` sources change (module-state read → param).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
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

/**
 * Resolve the legacy state-file path LAZILY (at call time, not import time) so
 * tests can redirect it via PI_CODING_AGENT_DIR AFTER this module is imported
 * (the previous goal.ts module-level `const STATE_FILE` was import-time and
 * thus untestable). In production PI_CODING_AGENT_DIR is set before the process
 * starts and never changes, so call-time vs import-time is observably
 * identical — zero behavior change.
 */
function stateFile(): string {
	return join(
		process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent"),
		"pi-goal-state.json",
	);
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
 * Null out the session-store entry (so a reload does not resurrect the goal)
 * AND drop the cwd key from the legacy JSON. Both are best-effort: a missing
 * api / missing legacy file are no-ops.
 */
export function clearPersistedGoal(api: GoalPersistenceApi | undefined, cwd: string): void {
	api?.appendEntry(GOAL_STATE_ENTRY_TYPE, { goal: null });
	clearLegacyPersistedGoal(cwd);
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

// ─── Legacy state file ────────────────────────────────────────────────────────
// Pre-session-store persistence: a JSON map keyed by cwd. Retained for
// continuity across restarts from older sessions; retired in Task 11.

function readState(): Record<string, unknown> {
	const file = stateFile();
	if (!existsSync(file)) return {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

export function clearLegacyPersistedGoal(cwd: string): void {
	const file = stateFile();
	if (!existsSync(file)) return;
	const goals = readState();
	delete goals[cwd];
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(goals, null, 2)}\n`);
}
