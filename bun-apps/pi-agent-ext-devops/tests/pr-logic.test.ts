/**
 * Tests for the PURE merge-recipe decision logic (no I/O). This is the heart
 * of await_pr_merge: given the current PR state + check tally, decide the next
 * action. Kept pure so it's fully testable without gh/git.
 */
import { test, expect, describe } from "bun:test";
import { decideRecipeAction } from "../src/pr-logic.js";
import type { CheckTally } from "../src/pr-logic.js";

const T = (pass = 0, fail = 0, pending = 0): CheckTally => ({ pass, fail, pending });

describe("decideRecipeAction", () => {
	test("MERGED → done (stop, success)", () => {
		expect(decideRecipeAction("MERGED", "CLEAN", T(5)).kind).toBe("done");
	});

	test("OPEN + all checks pass + CLEAN → merge (enable auto-merge)", () => {
		expect(decideRecipeAction("OPEN", "CLEAN", T(5, 0, 0)).kind).toBe("merge");
	});

	test("OPEN + pending checks → wait (keep polling)", () => {
		expect(decideRecipeAction("OPEN", "BLOCKED", T(2, 0, 3)).kind).toBe("wait");
	});

	test("OPEN + a failing check → fail (don't poll to timeout)", () => {
		const a = decideRecipeAction("OPEN", "BLOCKED", T(4, 1, 0));
		expect(a.kind).toBe("fail");
	});

	test("OPEN + BEHIND + 0 pending → rebase (rebase + force-push, CI reruns)", () => {
		expect(decideRecipeAction("OPEN", "BEHIND", T(5, 0, 0)).kind).toBe("rebase");
	});

	test("CLOSED (without merge) → fail", () => {
		const a = decideRecipeAction("CLOSED", "CLEAN", T(5));
		expect(a.kind).toBe("fail");
	});

	test("OPEN + BLOCKED + 0 pending + 0 fail → fail (not auto-resolvable)", () => {
		const a = decideRecipeAction("OPEN", "BLOCKED", T(5, 0, 0));
		expect(a.kind).toBe("fail");
	});

	test("OPEN + UNKNOWN + 0 pending → wait (transient, let GitHub settle)", () => {
		expect(decideRecipeAction("OPEN", "UNKNOWN", T(5, 0, 0)).kind).toBe("wait");
	});

	test("DIRTY (merge conflict) → fail", () => {
		expect(decideRecipeAction("OPEN", "DIRTY", T(5, 0, 0)).kind).toBe("fail");
	});
});
