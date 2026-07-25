/**
 * Unit tests for goal/persistence.ts (Phase 1, Task 6).
 *
 * persistence.ts is dep-injected (api / sessionManager passed as params; no
 * module-state reads), so these tests fake both without spinning up a pi
 * runtime. The legacy pi-goal-state.json is redirected into a temp dir via
 * PI_CODING_AGENT_DIR — which is why STATE_FILE must resolve LAZILY (call-time,
 * not import-time); see stateFile() in persistence.ts.
 */
import { test, expect, describe, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Redirect the legacy state file into a temp dir BEFORE importing persistence
// (lazy resolution reads this at call time). Saved so we can restore it.
const PREV_PI_DIR = process.env.PI_CODING_AGENT_DIR;
const TMP_STATE_DIR = mkdtempSync(join(tmpdir(), "persistence-state-"));
process.env.PI_CODING_AGENT_DIR = TMP_STATE_DIR;

const legacyFile = join(TMP_STATE_DIR, "pi-goal-state.json");

const { persistGoal, clearPersistedGoal, clearLegacyPersistedGoal, loadGoalFromSession, GOAL_STATE_ENTRY_TYPE } =
	await import("../persistence.js");
const { createGoal } = await import("../state.js");

afterAll(() => {
	if (PREV_PI_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = PREV_PI_DIR;
	rmSync(TMP_STATE_DIR, { recursive: true, force: true });
});

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
	test("appends a null goal entry AND clears the legacy file for the cwd", () => {
		const cwd = mkdtempSync(join(tmpdir(), "persistence-cwd-"));
		writeFileSync(legacyFile, JSON.stringify({ [cwd]: { id: "legacy" } }));

		const { api, calls } = fakeApi();
		clearPersistedGoal(api, cwd);

		expect(calls).toHaveLength(1);
		expect(calls[0]![0]).toBe(GOAL_STATE_ENTRY_TYPE);
		expect((calls[0]![1] as { goal: unknown }).goal).toBeNull();
		// Legacy file's cwd key removed:
		const parsed = JSON.parse(readFileSync(legacyFile, "utf8"));
		expect(parsed[cwd]).toBeUndefined();
		rmSync(cwd, { recursive: true, force: true });
	});

	test("is a no-op for the session entry when api is undefined (legacy still clears)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "persistence-cwd-"));
		writeFileSync(legacyFile, JSON.stringify({ [cwd]: { id: "legacy" } }));
		expect(() => clearPersistedGoal(undefined, cwd)).not.toThrow();
		expect(JSON.parse(readFileSync(legacyFile, "utf8"))[cwd]).toBeUndefined();
		rmSync(cwd, { recursive: true, force: true });
	});
});

// ─── clearLegacyPersistedGoal ─────────────────────────────────────────────────

describe("clearLegacyPersistedGoal", () => {
	test("removes only the cwd key, leaving other cwds intact", () => {
		const cwd = mkdtempSync(join(tmpdir(), "persistence-cwd2-"));
		writeFileSync(legacyFile, JSON.stringify({ [cwd]: { id: "z" }, other: { id: "keep" } }));

		clearLegacyPersistedGoal(cwd);

		const parsed = JSON.parse(readFileSync(legacyFile, "utf8"));
		expect(parsed[cwd]).toBeUndefined();
		expect(parsed.other).toEqual({ id: "keep" });
		rmSync(cwd, { recursive: true, force: true });
	});

	test("is a no-op when the legacy file does not exist (no creation)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "persistence-cwd3-"));
		if (existsSync(legacyFile)) rmSync(legacyFile);
		expect(() => clearLegacyPersistedGoal(cwd)).not.toThrow();
		expect(existsSync(legacyFile)).toBe(false); // did NOT create it
		rmSync(cwd, { recursive: true, force: true });
	});

	test("tolerates a corrupt JSON file (returns empty, rewrites)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "persistence-cwd4-"));
		writeFileSync(legacyFile, "{ not valid json");
		expect(() => clearLegacyPersistedGoal(cwd)).not.toThrow();
		// File rewritten as valid JSON (empty object minus cwd).
		const parsed = JSON.parse(readFileSync(legacyFile, "utf8"));
		expect(parsed[cwd]).toBeUndefined();
		rmSync(cwd, { recursive: true, force: true });
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
