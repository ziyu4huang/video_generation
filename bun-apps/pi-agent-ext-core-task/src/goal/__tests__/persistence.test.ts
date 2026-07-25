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

const { persistGoal, clearPersistedGoal, loadGoalFromSession, GOAL_STATE_ENTRY_TYPE } = await import(
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
