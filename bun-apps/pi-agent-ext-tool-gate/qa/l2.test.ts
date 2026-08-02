/**
 * L2 reachability — deterministic unit tests (wayfinder ticket 04).
 *
 * Verifies the reachability evaluator's predictions against the curated task
 * suite. (Live-usage tier is not unit-testable without a model — flagged
 * experimental in l2.ts.)
 */
import { describe, test, expect } from "bun:test";
import { evaluateReachability, summarizeReachability, detectToolUsage } from "./l2.ts";
import { L2_TASKS } from "./l2-tasks.ts";

describe("L2 reachability — predictions hold", () => {
	const r = evaluateReachability();
	for (const x of r) {
		test(`${x.task.id}: onReachable=${x.onReachable} matches expectReachable=${x.task.expectReachable}`, () => {
			expect(x.predictionHeld).toBe(true);
		});
	}
});

describe("L2 reachability — confirmed gaps (task-level blind/misroute)", () => {
	test("after the fix, ZERO tasks are unreachable under ON (all 9 reachable)", () => {
		const gaps = evaluateReachability().filter((x) => x.gap).map((x) => x.task.id);
		expect(gaps).toEqual([]);
	});
	test("movie-film no longer misroutes (movie reaches; workflow may also fire, but movie is reachable)", () => {
		const film = evaluateReachability().find((x) => x.task.id === "movie-film")!;
		expect(film.onReachable).toBe(true);
	});
});

describe("L2 reachability — summary", () => {
	test("9/9 reachable, 0 gaps after the fix", () => {
		const s = summarizeReachability(evaluateReachability());
		expect(s.total).toBe(L2_TASKS.length);
		expect(s.reachable).toBe(9);
		expect(s.gaps).toBe(0);
		expect(s.predictionsHeld).toBe(true);
	});
});

describe("L2 detectToolUsage — heuristic", () => {
	test("matches the tool name as a word; ignores substrings", () => {
		expect(detectToolUsage("calling flux2 now", "flux2")).toBe(true);
		expect(detectToolUsage("refluxing the system", "flux2")).toBe(false);
	});
});
