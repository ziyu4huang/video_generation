import { describe, expect, test } from "bun:test";
import { applyDefaultTokenBudget, DEFAULT_GOAL_TOKEN_BUDGET, createGoal } from "../state.js";

describe("applyDefaultTokenBudget", () => {
	test("sets the default when the goal was created without --tokens", () => {
		const goal = createGoal("ship it", undefined, 0);
		applyDefaultTokenBudget(goal);
		expect(goal.tokenBudget).toBe(DEFAULT_GOAL_TOKEN_BUDGET);
	});
	test("leaves an explicit budget untouched", () => {
		const goal = createGoal("ship it", 1_000_000, 0);
		applyDefaultTokenBudget(goal);
		expect(goal.tokenBudget).toBe(1_000_000);
	});
	test("idempotent — applying twice keeps the default", () => {
		const goal = createGoal("ship it", undefined, 0);
		applyDefaultTokenBudget(goal);
		applyDefaultTokenBudget(goal);
		expect(goal.tokenBudget).toBe(DEFAULT_GOAL_TOKEN_BUDGET);
	});
});
