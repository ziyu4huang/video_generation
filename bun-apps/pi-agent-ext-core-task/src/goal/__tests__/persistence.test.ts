/**
 * Unit tests for goal/persistence.ts (Phase 1, Task 6).
 *
 * persistence.ts is dep-injected (api / sessionManager passed as params; no
 * module-state reads, no file I/O), so these tests fake both without spinning
 * up a pi runtime. Since Task 11 retired the legacy file-based state,
 * persistence is session-store-only — no PI_CODING_AGENT_DIR redirection is
 * needed here.
 */
import { test, expect, describe } from "bun:test";
import type { ActiveGoal, GoalListItem } from "../format.js";

const {
	persistGoal,
	clearPersistedGoal,
	persistGoalState,
	loadGoalStateFromSession,
	GOAL_STATE_ENTRY_TYPE,
	REVIEWER_ENTRY_TYPE,
	appendReviewerEntry,
	loadReviewerEntries,
} = await import("../persistence.js");
const { createGoal, goalState, __resetGoalState } = await import("../state.js");

type ApiCalls = Array<[customType: string, data: unknown]>;

function fakeApi(): { api: { appendEntry: (t: string, d: unknown) => void }; calls: ApiCalls } {
	const calls: ApiCalls = [];
	const api = { appendEntry: (t: string, d: unknown) => void calls.push([t, d]) };
	return { api, calls };
}

function activeGoal(id = "g1") {
	return {
		id,
		text: "ship it",
		status: "active" as const,
		startedAt: 1000,
		updatedAt: 1000,
		iteration: 0,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		baselineTokens: 0,
	};
}

// ─── Constants ────────────────────────────────────────────────────────────────

describe("persistence constants", () => {
	test("GOAL_STATE_ENTRY_TYPE is the session-store customType", () => {
		expect(GOAL_STATE_ENTRY_TYPE).toBe("goal-state");
	});
});

// ─── persistGoal ──────────────────────────────────────────────────────────────

describe("persistGoal", () => {
	test("appends a goal-state entry via the injected api", () => {
		__resetGoalState();
		const { api, calls } = fakeApi();
		const goal = createGoal("x", undefined, 0);
		persistGoal(api, goal);
		expect(calls).toHaveLength(1);
		expect(calls[0]![0]).toBe(GOAL_STATE_ENTRY_TYPE);
		expect((calls[0]![1] as { goal: { id: string } }).goal.id).toBe(goal.id);
	});

	test("clones the goal so the store never holds the live reference", () => {
		__resetGoalState();
		const { api, calls } = fakeApi();
		const goal = createGoal("x", undefined, 0);
		persistGoal(api, goal);
		const stored = (calls[0]![1] as { goal: { id: string } }).goal;
		expect(stored).not.toBe(goal); // different reference (cloned)
		expect(stored.id).toBe(goal.id); // same data
	});

	test("snapshots goalState.list alongside the goal (Task 5a delegation)", () => {
		__resetGoalState();
		goalState.list = [{ id: "t1", text: "queued" }];
		const logged: any[] = [];
		const api = { appendEntry: (t: string, d: unknown) => logged.push({ customType: t, data: d }) };
		persistGoal(api as any, {
			id: "g1",
			text: "head",
			status: "active",
			startedAt: 0,
			updatedAt: 0,
			iteration: 0,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			baselineTokens: 0,
		} as any);
		expect(logged[0].data.goal.text).toBe("head");
		expect(logged[0].data.list).toEqual([{ id: "t1", text: "queued" }]);
	});

	test("with empty goalState.list writes list: []", () => {
		__resetGoalState();
		const logged: any[] = [];
		const api = { appendEntry: (_t: string, d: unknown) => logged.push({ data: d }) };
		persistGoal(api as any, {
			id: "g1",
			text: "head",
			status: "active",
			startedAt: 0,
			updatedAt: 0,
			iteration: 0,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			baselineTokens: 0,
		} as any);
		expect(logged[0].data.list).toEqual([]);
	});

	test("is a no-op when api is undefined", () => {
		expect(() => persistGoal(undefined, createGoal("x", undefined, 0))).not.toThrow();
	});
});

// ─── clearPersistedGoal ───────────────────────────────────────────────────────

describe("clearPersistedGoal", () => {
	test("appends a null goal entry via the injected api", () => {
		const { api, calls } = fakeApi();
		clearPersistedGoal(api);
		expect(calls).toHaveLength(1);
		expect(calls[0]![0]).toBe(GOAL_STATE_ENTRY_TYPE);
		expect((calls[0]![1] as { goal: unknown }).goal).toBeNull();
	});

	test("writes goal:null + list:[] (Task 5a — clears the tail too)", () => {
		const logged: any[] = [];
		const api = { appendEntry: (_t: string, d: unknown) => logged.push({ data: d }) };
		clearPersistedGoal(api as any);
		expect(logged[0].data.goal).toBeNull();
		expect(logged[0].data.list).toEqual([]);
	});

	test("is a no-op when api is undefined", () => {
		expect(() => clearPersistedGoal(undefined)).not.toThrow();
	});
});

// (The legacy head-only loader was removed in Task 5a — superseded by
// loadGoalStateFromSession, whose tests below already cover head + tail
// recovery, most-recent-wins, complete-goal exclusion, and CLONE behavior.)

// ─── persistGoalState (Loop 2, Task 3: head + tail in one entry) ───────────────

describe("persistGoalState", () => {
	test("appends an entry carrying goal + list", () => {
		const logged: any[] = [];
		const api = { appendEntry: (t: string, d: unknown) => logged.push({ type: "custom", customType: t, data: d }) };
		const goal: ActiveGoal = {
			id: "g1",
			text: "head",
			status: "active",
			startedAt: 0,
			updatedAt: 0,
			iteration: 0,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			baselineTokens: 0,
		};
		const list: GoalListItem[] = [{ id: "t1", text: "next" }];
		persistGoalState(api as any, goal, list);
		expect(logged).toHaveLength(1);
		expect(logged[0].data.goal.text).toBe("head");
		expect(logged[0].data.list).toEqual(list);
	});

	test("null goal still persists the list", () => {
		const logged: any[] = [];
		const api = { appendEntry: (_t: string, d: unknown) => logged.push({ data: d }) };
		persistGoalState(api as any, null, [{ id: "t1", text: "x" }]);
		expect(logged[0].data.goal).toBeNull();
		expect(logged[0].data.list).toHaveLength(1);
	});

	test("shallow-clones each list item (store never holds the live ref)", () => {
		const logged: any[] = [];
		const api = { appendEntry: (_t: string, d: unknown) => logged.push({ data: d }) };
		const item: GoalListItem = { id: "t1", text: "next" };
		persistGoalState(api as any, null, [item]);
		expect(logged[0].data.list[0]).not.toBe(item); // different reference (cloned)
		expect(logged[0].data.list[0]).toEqual(item); // same data
	});

	test("is a no-op when api is undefined", () => {
		expect(() => persistGoalState(undefined, null, [])).not.toThrow();
	});
});

// ─── loadGoalStateFromSession (Loop 2, Task 3: recover head + tail) ───────────

function fakeSmState(entries: any[]) {
	return { getBranch: () => entries, getEntries: () => entries };
}

describe("loadGoalStateFromSession", () => {
	test("recovers a non-complete goal + its list", () => {
		const goal: ActiveGoal = {
			id: "g1",
			text: "head",
			status: "active",
			startedAt: 0,
			updatedAt: 0,
			iteration: 0,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			baselineTokens: 0,
		};
		const list: GoalListItem[] = [{ id: "t1", text: "next" }];
		const sm = fakeSmState([{ type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: { goal, list } }]);
		const r = loadGoalStateFromSession(sm);
		expect(r.goal?.id).toBe("g1");
		expect(r.list).toEqual(list);
	});

	test("complete goal excluded, but list still recovered", () => {
		const goal: ActiveGoal = {
			id: "g1",
			text: "head",
			status: "complete",
			startedAt: 0,
			updatedAt: 0,
			iteration: 0,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			baselineTokens: 0,
		};
		const sm = fakeSmState([
			{ type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: { goal, list: [{ id: "t1", text: "next" }] } },
		]);
		const r = loadGoalStateFromSession(sm);
		expect(r.goal).toBeUndefined();
		expect(r.list?.[0].text).toBe("next");
	});

	test("uses the LAST goal-state entry (most recent wins)", () => {
		const sm = fakeSmState([
			{
				type: "custom",
				customType: GOAL_STATE_ENTRY_TYPE,
				data: { goal: { ...activeGoal("old"), baselineTokens: 0 }, list: [{ id: "t1", text: "old-next" }] },
			},
			{
				type: "custom",
				customType: GOAL_STATE_ENTRY_TYPE,
				data: { goal: { ...activeGoal("new"), baselineTokens: 0 }, list: [{ id: "t2", text: "new-next" }] },
			},
		]);
		const r = loadGoalStateFromSession(sm);
		expect(r.goal?.id).toBe("new");
		expect(r.list?.[0].text).toBe("new-next");
	});

	test("returns undefined/empty when there is no goal-state entry", () => {
		const sm = fakeSmState([{ type: "custom", customType: "other-type", data: { goal: activeGoal(), list: [] } }]);
		const r = loadGoalStateFromSession(sm);
		expect(r.goal).toBeUndefined();
		expect(r.list).toBeUndefined();
	});

	test("returns undefined/empty when sessionManager is undefined / has no readers", () => {
		expect(loadGoalStateFromSession(undefined)).toEqual({});
		expect(loadGoalStateFromSession({})).toEqual({});
	});

	test("returns CLONEs of the stored goal + list items", () => {
		// The pi runtime may freeze/canonicalize entry data; callers mutate the
		// returned goal (updateGoalUsage) + may reorder the list. The loader must
		// hand back copies, not shared references.
		const storedGoal = Object.freeze(activeGoal("frozen"));
		const storedItem = Object.freeze({ id: "t1", text: "next" });
		const sm = fakeSmState([
			{
				type: "custom",
				customType: GOAL_STATE_ENTRY_TYPE,
				data: Object.freeze({ goal: storedGoal, list: [storedItem] }),
			},
		]);
		const r = loadGoalStateFromSession(sm);
		expect(r.goal?.id).toBe("frozen");
		expect(r.goal).not.toBe(storedGoal); // goal clone, not same ref
		expect(r.list?.[0]).not.toBe(storedItem); // list-item clone, not same ref
		expect(r.list?.[0]).toEqual(storedItem);
		expect(() => {
			(r.goal as { tokensUsed: number }).tokensUsed = 42;
		}).not.toThrow();
	});
});

// ─── Reviewer ledger persistence (Task 4) ─────────────────────────────────────

describe("reviewer ledger persistence", () => {
	test("appendReviewerEntry -> loadReviewerEntries round-trips by entry type", () => {
		const store: Array<{ type: string; customType?: string; data: unknown }> = [];
		const fakeApi = {
			appendEntry: (customType: string, data: unknown) => {
				store.push({ type: "custom", customType, data });
			},
		};
		const fakeSm = { getEntries: () => store };

		appendReviewerEntry(fakeApi as never, {
			type: "reviewer_fired",
			at: "2026-07-31T12:00:00.000Z",
			goalId: "g1",
			cascadeStep: "convert-findings-to-list",
			enqueued: 2,
			proposed: 0,
		});
		appendReviewerEntry(fakeApi as never, {
			type: "reviewer_suppressed",
			at: "2026-07-31T12:01:00.000Z",
			goalId: "g2",
			reason: "refire-window",
		});

		const entries = loadReviewerEntries(fakeSm as never);
		expect(entries).toHaveLength(2);
		expect(entries[0]!.type).toBe("reviewer_fired");
		expect(entries[1]!.reason).toBe("refire-window");
	});

	test("REVIEWER_ENTRY_TYPE is 'goal-reviewer'", () => {
		expect(REVIEWER_ENTRY_TYPE).toBe("goal-reviewer");
	});
});
