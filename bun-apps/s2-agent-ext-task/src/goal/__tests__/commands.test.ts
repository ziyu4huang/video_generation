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
	parseListCommand,
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

// ─── parseCommand audit flags ───────────────────────────────────────────────

describe("parseCommand audit flags", () => {
	test("--audit flag sets audit=true and carries the objective", () => {
		const r = parseCommand('--audit "ship feature X"');
		expect(typeof r).toBe("object");
		if (typeof r === "object") {
			expect(r).toEqual({
				kind: "start",
				objective: "ship feature X",
				audit: true,
			});
		}
	});

	test("--audit --model provider/id carries the auditor model", () => {
		const r = parseCommand('--audit --model anthropic/claude-sonnet-4 "ship feature X"');
		if (typeof r === "object") expect(r.auditorModel).toBe("anthropic/claude-sonnet-4");
	});

	test("--model provider/id works without --audit", () => {
		const r = parseCommand('--model anthropic/claude-sonnet-4 "ship feature X"');
		if (typeof r === "object") expect(r.auditorModel).toBe("anthropic/claude-sonnet-4");
	});

	test("no --audit flag → audit is undefined (default off)", () => {
		const r = parseCommand('"ship feature X"');
		if (typeof r === "object") expect(r.audit).toBeUndefined();
	});

	test("'audit' subcommand → recognized as a toggle (not an objective)", () => {
		const r = parseCommand("audit");
		expect(r).toEqual({ kind: "audit" });
	});

	test("'audit' with extra args → usage error", () => {
		expect(typeof parseCommand("audit now")).toBe("string");
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

// ─── parseListCommand ─────────────────────────────────────────────────────────

describe("/goal review parsing", () => {
	test("review on -> { kind: review, mode: 'on' }", () => {
		expect(parseCommand("review on")).toEqual({ kind: "review", mode: "on" });
	});
	test("review off -> { kind: review, mode: 'off' }", () => {
		expect(parseCommand("review off")).toEqual({ kind: "review", mode: "off" });
	});
	test("review auto -> { kind: review, mode: 'auto' }", () => {
		expect(parseCommand("review auto")).toEqual({ kind: "review", mode: "auto" });
	});
	test("review aggressive -> { kind: review, mode: 'aggressive' }", () => {
		expect(parseCommand("review aggressive")).toEqual({ kind: "review", mode: "aggressive" });
	});
	test("review with no/bad arg -> usage error string", () => {
		expect(typeof parseCommand("review")).toBe("string");
		expect(typeof parseCommand("review maybe")).toBe("string");
	});
});

describe("parseListCommand", () => {
	test("bare /list → show", () => {
		expect(parseListCommand("list")).toEqual({ kind: "show" });
		expect(parseListCommand("list ")).toEqual({ kind: "show" });
	});
	test("/list add with one objective", () => {
		expect(parseListCommand('list add "ship feature X"')).toEqual({ kind: "add", texts: ["ship feature X"] });
	});
	test("/list add with multiple objectives", () => {
		expect(parseListCommand('list add "a" "b" "c"')).toEqual({ kind: "add", texts: ["a", "b", "c"] });
	});
	test("/list next", () => {
		expect(parseListCommand("list next")).toEqual({ kind: "next" });
	});
	test("/list remove <n>", () => {
		expect(parseListCommand("list remove 2")).toEqual({ kind: "remove", index: 2 });
	});
	test("/list remove non-numeric → -1", () => {
		expect(parseListCommand("list remove abc")).toEqual({ kind: "remove", index: -1 });
	});
	test("/list clear", () => {
		expect(parseListCommand("list clear")).toEqual({ kind: "clear" });
	});
	test("non-list input → null (not a list command)", () => {
		expect(parseListCommand('goal "something"')).toBeNull();
		expect(parseListCommand("audit")).toBeNull();
	});
	test("unknown /list subcommand → show (forgiving)", () => {
		expect(parseListCommand("list frobnicate")).toEqual({ kind: "show" });
	});
});

// ─── CC surface parity (ticket 04) ────────────────────────────────────────────

describe("CC surface parity", () => {
	test("no args shows status instead of usage", () => {
		expect(parseCommand("")).toEqual({ kind: "show" });
		expect(parseCommand("   ")).toEqual({ kind: "show" });
	});
	test("CC clear aliases all clear", () => {
		for (const alias of ["clear", "stop", "off", "reset", "none", "cancel"]) {
			const r = parseCommand(alias);
			expect(r).toEqual({ kind: "clear" });
		}
	});
	test("alias with trailing args is a usage error", () => {
		expect(typeof parseCommand("cancel now")).toBe("string");
		expect(typeof parseCommand("off x")).toBe("string");
	});
	test("condition still capped at 4000 (validateObjective, the lifecycle gate)", () => {
		expect(typeof validateObjective("x".repeat(4001))).toBe("string");
		expect(validateObjective("x".repeat(4000))).toBeUndefined();
	});
});

// ─── Plan approval (ticket 01: /goal approve) ────────────────────────────────

describe("plan approval command parsing (ticket 01)", () => {
	test("approve parses bare; trailing args are a usage error", () => {
		expect(parseCommand("approve")).toEqual({ kind: "approve" });
		expect(typeof parseCommand("approve now")).toBe("string");
		expect(parseCommand("approve now")).toMatch(/Usage: \/goal approve/);
	});
	test("approve appears in argument completions", () => {
		const completions = completeGoalArguments("") ?? [];
		expect(completions.some((c) => c.value === "approve")).toBe(true);
	});
});
