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

const { persistGoal, clearPersistedGoal, loadGoalFromSession, persistGoalState, loadGoalStateFromSession, GOAL_STATE_ENTRY_TYPE } = await import(
	"../persistence.js"
);
const { createGoal } = await import("../state.js");

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
		const { api, calls } = fakeApi();
		const goal = createGoal("x", undefined, 0);
		persistGoal(api, goal);
		expect(calls).toHaveLength(1);
		expect(calls[0]![0]).toBe(GOAL_STATE_ENTRY_TYPE);
		expect((calls[0]![1] as { goal: { id: string } }).goal.id).toBe(goal.id);
	});

	test("clones the goal so the store never holds the live reference", () => {
		const { api, calls } = fakeApi();
		const goal = createGoal("x", undefined, 0);
		persistGoal(api, goal);
		const stored = (calls[0]![1] as { goal: { id: string } }).goal;
		expect(stored).not.toBe(goal); // different reference (cloned)
		expect(stored.id).toBe(goal.id); // same data
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

	test("is a no-op when api is undefined", () => {
		expect(() => clearPersistedGoal(undefined)).not.toThrow();
	});
});

// ─── loadGoalFromSession ──────────────────────────────────────────────────────

describe("loadGoalFromSession", () => {
	test("returns the active goal from getBranch entries", () => {
		const goal = activeGoal("branch-1");
		const sm = { getBranch: () => [{ type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: { goal } }] };
		const loaded = loadGoalFromSession(sm);
		expect(loaded?.id).toBe("branch-1");
		expect(loaded?.status).toBe("active");
	});

	test("falls back to getEntries when getBranch is absent", () => {
		const goal = activeGoal("entries-1");
		const sm = { getEntries: () => [{ type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: { goal } }] };
		const loaded = loadGoalFromSession(sm);
		expect(loaded?.id).toBe("entries-1");
	});

	test("uses the LAST goal-state entry (most recent wins)", () => {
		const sm = {
			getBranch: () => [
				{ type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: { goal: activeGoal("old") } },
				{ type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: { goal: activeGoal("new") } },
			],
		};
		expect(loadGoalFromSession(sm)?.id).toBe("new");
	});

	test("returns undefined for a complete goal", () => {
		const goal = { ...activeGoal("done"), status: "complete" as const };
		const sm = { getBranch: () => [{ type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: { goal } }] };
		expect(loadGoalFromSession(sm)).toBeUndefined();
	});

	test("returns undefined when there is no goal-state entry", () => {
		const sm = { getBranch: () => [{ type: "custom", customType: "other-type", data: { goal: activeGoal() } }] };
		expect(loadGoalFromSession(sm)).toBeUndefined();
	});

	test("returns undefined when entry data is not a goal", () => {
		const sm = {
			getBranch: () => [{ type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: { goal: { id: 1 } } }],
		};
		expect(loadGoalFromSession(sm)).toBeUndefined();
	});

	test("returns undefined when sessionManager is undefined / has no readers", () => {
		expect(loadGoalFromSession(undefined)).toBeUndefined();
		expect(loadGoalFromSession({})).toBeUndefined();
	});

	test("returns a CLONE — not the session store's (possibly frozen) reference", () => {
		// The pi runtime may freeze/canonicalize entry data; callers mutate the
		// returned goal (updateGoalUsage). The loader must hand back a copy.
		const frozenGoal = Object.freeze(activeGoal("frozen"));
		const sm = {
			getBranch: () => [
				{ type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: Object.freeze({ goal: frozenGoal }) },
			],
		};
		const loaded = loadGoalFromSession(sm);
		expect(loaded?.id).toBe("frozen");
		expect(loaded).not.toBe(frozenGoal); // a clone, not the same ref
		// And the clone is mutable:
		expect(() => {
			(loaded as { tokensUsed: number }).tokensUsed = 42;
		}).not.toThrow();
		expect(loaded?.tokensUsed).toBe(42);
	});
});

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
