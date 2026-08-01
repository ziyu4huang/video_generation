/**
 * Tests for the PURE progress formatter that turns a ProgressUpdate into the
 * live one-line status shown in the TUI while await_pr_merge polls.
 */
import { test, expect, describe } from "bun:test";
import { formatProgress } from "../src/progress.js";
import type { ProgressUpdate } from "../src/recipe.js";

function u(over: Partial<ProgressUpdate>): ProgressUpdate {
	return {
		prNumber: 975,
		pollNumber: 3,
		elapsedMs: 42_000,
		state: "OPEN",
		mergeState: "BLOCKED",
		checks: { pass: 30, fail: 0, pending: 5 },
		action: "wait",
		behind: false,
		...over,
	};
}

describe("formatProgress", () => {
	test("wait action → CI running suffix", () => {
		expect(formatProgress(u({ action: "wait" }))).toBe(
			"⏳ PR #975 · 42s · poll 3 · checks 30/0/5 · CI running…",
		);
	});

	test("merge action → auto-merge armed suffix", () => {
		expect(formatProgress(u({ action: "merge", checks: { pass: 35, fail: 0, pending: 0 } }))).toBe(
			"⏳ PR #975 · 42s · poll 3 · checks 35/0/0 · checks green → auto-merge armed",
		);
	});

	test("rebase action → rebasing suffix", () => {
		expect(formatProgress(u({ action: "rebase", mergeState: "BEHIND", behind: true }))).toBe(
			"⏳ PR #975 · 42s · poll 3 · checks 30/0/5 · BEHIND → rebasing + force-pushing…",
		);
	});

	test("done action → merged suffix", () => {
		expect(formatProgress(u({ action: "done", state: "MERGED" }))).toBe(
			"⏳ PR #975 · 42s · poll 3 · checks 30/0/5 · merged ✓",
		);
	});

	test("elapsed is floor-rounded to seconds", () => {
		expect(formatProgress(u({ elapsedMs: 42_500 }))).toContain("· 42s ·");
	});

	test("checks tally is pass/fail/pending", () => {
		const line = formatProgress(u({ checks: { pass: 12, fail: 2, pending: 7 } }));
		expect(line).toContain("checks 12/2/7");
	});
});
