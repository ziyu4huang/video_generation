/**
 * Unit tests for the /goal command-parsing helpers extracted from goal.ts into
 * commands.ts (Phase 1, Task 2).
 *
 * These are pure functions with ZERO @earendil-works/* dependencies, so they
 * are exercised directly here under plain Bun. The broader behavior (full
 * command routing, argument completions, validation interplay with goal
 * lifecycle) stays covered by goal.test.ts, which imports the same symbols via
 * the goal.ts re-export seam.
 */
import { test, expect, describe } from "bun:test";
import {
	parseTokenBudget,
	tokenize,
	parseCommand,
	validateObjective,
	completeGoalArguments,
} from "../commands.js";

// ─── parseTokenBudget ────────────────────────────────────────────────────────

describe("parseTokenBudget", () => {
	test("parses k/m/plain", () => {
		expect(parseTokenBudget("100k")).toBe(100_000);
		expect(parseTokenBudget("1.5m")).toBe(1_500_000);
		expect(parseTokenBudget("500")).toBe(500);
	});

	test("rejects zero, negative, and non-numeric input", () => {
		expect(parseTokenBudget("0")).toBeUndefined();
		expect(parseTokenBudget("-5")).toBeUndefined();
		expect(parseTokenBudget("nope")).toBeUndefined();
		expect(parseTokenBudget("")).toBeUndefined();
	});

	test("is case-insensitive on suffix", () => {
		expect(parseTokenBudget("2K")).toBe(2_000);
		expect(parseTokenBudget("3M")).toBe(3_000_000);
	});
});

// ─── tokenize ────────────────────────────────────────────────────────────────

describe("tokenize", () => {
	test("handles quotes and spaces", () => {
		expect(tokenize(`fix "the bug" now`)).toEqual(["fix", "the bug", "now"]);
	});

	test("handles single quotes", () => {
		expect(tokenize(`ship 'the feature'`)).toEqual(["ship", "the feature"]);
	});

	test("collapses repeated whitespace", () => {
		expect(tokenize("a   b\tc")).toEqual(["a", "b", "c"]);
	});

	test("returns empty array for blank input", () => {
		expect(tokenize("")).toEqual([]);
	});
});

// ─── parseCommand ────────────────────────────────────────────────────────────

describe("parseCommand", () => {
	test("routes subcommands", () => {
		expect(parseCommand("pause")).toEqual({ kind: "pause" });
		expect(typeof parseCommand("pause the pipeline")).toBe("string"); // ambiguous → usage string
		expect(parseCommand("status")).toEqual({ kind: "show" });
	});

	test("empty input shows status", () => {
		expect(parseCommand("")).toEqual({ kind: "show" });
	});

	test("clear / stop aliases", () => {
		expect(parseCommand("clear")).toEqual({ kind: "clear" });
		expect(parseCommand("stop")).toEqual({ kind: "clear" });
		expect(typeof parseCommand("clear now")).toBe("string");
	});

	test("edit and start parse --tokens budget", () => {
		expect(parseCommand('--tokens 1.5k "ship tests"')).toEqual({
			kind: "start",
			objective: "ship tests",
			tokenBudget: 1_500,
		});
		expect(parseCommand("edit --tokens 2m revise scope")).toEqual({
			kind: "edit",
			objective: "revise scope",
			tokenBudget: 2_000_000,
		});
	});
});

// ─── validateObjective ───────────────────────────────────────────────────────

describe("validateObjective", () => {
	test("rejects empty + over-length", () => {
		expect(validateObjective("   ")).toBeTruthy();
		expect(validateObjective("ship the feature")).toBeUndefined();
	});

	test("returns a usage string for empty input", () => {
		expect(validateObjective("")).toBe("Usage: /goal <goal_to_complete>");
	});

	test("rejects over-length objective", () => {
		const tooLong = "x".repeat(4_001);
		expect(validateObjective(tooLong)).toBeTruthy();
	});
});

// ─── completeGoalArguments ───────────────────────────────────────────────────

describe("completeGoalArguments", () => {
	test("returns all completions for empty prefix", () => {
		const all = completeGoalArguments("")!;
		expect(all.length).toBeGreaterThan(0);
	});

	test("filters by prefix", () => {
		expect(completeGoalArguments("pa")?.map((i) => i.value)).toEqual(["pause"]);
		expect(completeGoalArguments("--t")?.map((i) => i.value)).toEqual(["--tokens "]);
	});

	test("returns null when objective text is present", () => {
		expect(completeGoalArguments("ship objective")).toBeNull();
	});
});
