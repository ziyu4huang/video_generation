import { test, expect } from "bun:test";
import { parseHypothesis, buildLoopContinuationPrompt, isLoopActive } from "../loop.js";
import { __resetLoopState, getLoopState, createLoop } from "../loop-state.js";

test("parseHypothesis extracts the HYPOTHESIS: line", () => {
	expect(parseHypothesis("HYPOTHESIS: try caching\nsome code")).toBe("try caching");
	expect(parseHypothesis("no line here")).toBe("");
});

test("buildLoopContinuationPrompt requires HYPOTHESIS + forbids self-report in metric", () => {
	const l = createLoop({ target: "t", mode: "metric", measureCmd: "c", direction: "higher" });
	const p = buildLoopContinuationPrompt(l, "marker-1");
	expect(p).toContain("HYPOTHESIS:");
	expect(p).toContain("marker-1");
	expect(p).toContain("do not report");
});

test("buildLoopContinuationPrompt metricless omits the no-self-report rule", () => {
	const l = createLoop({ target: "t", mode: "metricless" });
	expect(buildLoopContinuationPrompt(l, "m")).not.toContain("do not report");
});

test("isLoopActive reflects loopState", () => {
	__resetLoopState();
	expect(isLoopActive()).toBe(false);
	getLoopState().activeLoop = createLoop({ target: "t", mode: "metricless" });
	expect(isLoopActive()).toBe(true);
	__resetLoopState();
});
