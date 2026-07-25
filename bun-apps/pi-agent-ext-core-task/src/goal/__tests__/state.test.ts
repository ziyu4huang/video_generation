/**
 * Unit tests for the pure goal status-machine helpers extracted from goal.ts
 * into state.ts (Phase 1, Task 4). state.ts holds goal-owned types + the pure
 * status-machine functions; it must have ZERO @earendil-works/* imports
 * (only "crypto" + local ../format.js). These tests pin the pure behavior.
 */
import { test, expect } from "bun:test";
import {
	createGoal,
	transitionGoal,
	normalizeGoalForBudget,
	incrementGoal,
	cloneGoal,
	isGoal,
	type ActiveGoal,
} from "../state.js";

test("createGoal seeds an active goal with the right shape", () => {
	const g = createGoal("do thing", 1000, 42);
	expect(g.id).toEqual(expect.any(String));
	expect(g.text).toBe("do thing");
	expect(g.status).toBe("active");
	expect(g.iteration).toBe(0);
	expect(g.tokensUsed).toBe(0);
	expect(g.baselineTokens).toBe(42);
	expect(g.tokenBudget).toBe(1000);
	expect(g.updatedAt).toBeGreaterThanOrEqual(g.startedAt);
});

test("normalizeGoalForBudget flips active → budget_limited at the cap", () => {
	const g = createGoal("x", 1000, 0);
	g.tokensUsed = 1000;
	expect(normalizeGoalForBudget({ ...g, status: "active" }).status).toBe("budget_limited");
});

test("normalizeGoalForBudget leaves below-budget active goals alone", () => {
	const g = createGoal("x", 1000, 0);
	g.tokensUsed = 999;
	expect(normalizeGoalForBudget({ ...g, status: "active" }).status).toBe("active");
});

test("normalizeGoalForBudget does not reactivate a budget_limited goal under budget", () => {
	const g = createGoal("x", 1000, 0);
	g.tokensUsed = 500;
	expect(normalizeGoalForBudget({ ...g, status: "budget_limited" }).status).toBe("budget_limited");
});

test("isGoal rejects malformed objects", () => {
	expect(isGoal(null)).toBe(false);
	expect(isGoal({ id: "x" })).toBe(false);
	expect(isGoal(createGoal("x", undefined, 0))).toBe(true);
});

test("isGoal accepts a fully-shaped goal and narrows it", () => {
	const g = createGoal("x", undefined, 0);
	const narrowed = (v: unknown): v is ActiveGoal => isGoal(v);
	expect(narrowed(g)).toBe(true);
});

test("transitionGoal preserves identity + bumps updatedAt", () => {
	const g = createGoal("x", undefined, 0);
	const paused = transitionGoal(g, "paused");
	expect(paused.status).toBe("paused");
	expect(paused.id).toBe(g.id);
	expect(paused.updatedAt).toBeGreaterThanOrEqual(g.updatedAt);
});

test("transitionGoal to active via budget_limited cap flips to budget_limited", () => {
	const g = createGoal("x", 100, 0);
	g.tokensUsed = 100;
	const next = transitionGoal({ ...g, status: "paused" }, "active");
	expect(next.status).toBe("budget_limited");
});

test("incrementGoal bumps iteration and updatedAt without touching tokens", () => {
	const g = createGoal("x", undefined, 0);
	const next = incrementGoal(g);
	expect(next.iteration).toBe(g.iteration + 1);
	expect(next.tokensUsed).toBe(g.tokensUsed);
	expect(next.updatedAt).toBeGreaterThanOrEqual(g.updatedAt);
	// Original is not mutated.
	expect(g.iteration).toBe(0);
});

test("cloneGoal returns a deep copy that is not reference-equal", () => {
	const g = createGoal("x", undefined, 0);
	const copy = cloneGoal(g);
	expect(copy).toEqual(g);
	expect(copy).not.toBe(g);
	copy.tokensUsed = 99;
	expect(g.tokensUsed).toBe(0);
});
