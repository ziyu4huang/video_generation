import { test, expect, describe, beforeEach } from "bun:test";
import {
	createLoop, applyMeasurement, applyMetriclessTick, isBoundedStop, stopLoop,
	__resetLoopState, type LoopState,
} from "../loop-state.js";

test("createLoop builds an active metric loop with defaults", () => {
	const l = createLoop({ target: "harden security", mode: "metric", measureCmd: "echo 5", direction: "higher" });
	expect(l.active).toBe(true);
	expect(l.mode).toBe("metric");
	expect(l.iteration).toBe(0);
	expect(l.maxIterations).toBe(0);
	expect(l.stallCount).toBe(0);
	expect(l.bestValue).toBeUndefined();
	expect(l.plateauWindow).toBe(5);
	expect(l.history).toEqual([]);
});

test("applyMeasurement: first reading is the baseline (improved, no stall)", () => {
	const l = createLoop({ target: "t", mode: "metric", measureCmd: "c", direction: "higher" });
	const next = applyMeasurement(l, 10, "h1");
	expect(next.bestValue).toBe(10);
	expect(next.lastValue).toBe(10);
	expect(next.stallCount).toBe(0);
	expect(next.history.at(-1)?.verdict).toBe("improved");
});

test("applyMeasurement: higher-direction improvement resets stall", () => {
	let l = createLoop({ target: "t", mode: "metric", measureCmd: "c", direction: "higher" });
	l = applyMeasurement(l, 10, "h1");
	l = applyMeasurement(l, 8, "h2");   // regress vs best -> plateau-eligible
	expect(l.stallCount).toBe(1);
	l = applyMeasurement(l, 12, "h3");  // new best
	expect(l.bestValue).toBe(12);
	expect(l.stallCount).toBe(0);
	expect(l.history.at(-1)?.verdict).toBe("improved");
});

test("applyMeasurement: lower-direction treats smaller as better", () => {
	let l = createLoop({ target: "t", mode: "metric", measureCmd: "c", direction: "lower" });
	l = applyMeasurement(l, 100, "h1");
	l = applyMeasurement(l, 90, "h2");
	expect(l.bestValue).toBe(90);
	expect(l.stallCount).toBe(0);
	l = applyMeasurement(l, 95, "h3");
	expect(l.stallCount).toBe(1);
});

test("applyMetriclessTick logs iteration + hypothesis, no value", () => {
	let l = createLoop({ target: "t", mode: "metricless" });
	l = applyMetriclessTick(l, "try X");
	expect(l.history.at(-1)).toMatchObject({ hypothesis: "try X", verdict: "metricless" });
	expect(l.history.at(-1)?.value).toBeUndefined();
});

test("isBoundedStop hits max/time/tokens/plateau in priority order", () => {
	const base = createLoop({ target: "t", mode: "metric", measureCmd: "c", direction: "higher", maxIterations: 2 });
	expect(isBoundedStop({ ...base, iteration: 2 })).toBe("max");
	const t = { ...base, maxIterations: 0, timeLimitMs: 1000, startedAt: Date.now() - 2000 };
	expect(isBoundedStop(t)).toBe("time");
	const tok = { ...base, maxIterations: 0, tokenBudget: 100, tokensUsed: 150 };
	expect(isBoundedStop(tok)).toBe("tokens");
	const plat = { ...base, maxIterations: 0, stallCount: 5, plateauWindow: 5 };
	expect(isBoundedStop(plat)).toBe("plateau");
	expect(isBoundedStop({ ...base, maxIterations: 0 })).toBeUndefined();
});

test("history is FIFO-capped at 50", () => {
	let l = createLoop({ target: "t", mode: "metricless" });
	for (let i = 0; i < 60; i++) l = applyMetriclessTick(l, `h${i}`);
	expect(l.history.length).toBe(50);
	expect(l.history[0]?.hypothesis).toBe("h10");
});

test("stopLoop sets active=false + stopReason", () => {
	const l = stopLoop(createLoop({ target: "t", mode: "metricless" }), "user");
	expect(l.active).toBe(false);
	expect(l.stopReason).toBe("user");
});

// ─── Optimization #3 / ticket #16: per-sessionId loop-state isolation ────────

describe("per-sessionId loop-state isolation (ticket #16)", () => {
	const { setLoopRenderSid, getLoopState, __resetLoopState } = require("../loop-state.js");

	beforeEach(() => {
		__resetLoopState(); // no-arg: clear ALL buckets + reset renderSid
	});

	test("#3 loop-state isolated per sessionId (parent vs in-process child)", () => {
		setLoopRenderSid("parent");
		// parent activates a loop
		getLoopState("parent").activeLoop = createLoop({ target: "parent loop", mode: "metricless" });
		// child (distinct sid) activates a DIFFERENT loop — must NOT touch the parent bucket
		getLoopState("child").activeLoop = createLoop({ target: "child loop", mode: "metricless" });

		expect(getLoopState("parent").activeLoop?.target).toBe("parent loop");
		expect(getLoopState("child").activeLoop?.target).toBe("child loop");
		// no-arg reads the renderSid (parent) bucket — display code sees the parent's loop
		expect(getLoopState().activeLoop?.target).toBe("parent loop");
		// resetting the child leaves the parent intact
		__resetLoopState("child");
		expect(getLoopState("parent").activeLoop?.target).toBe("parent loop");
		expect(getLoopState("child").activeLoop).toBeUndefined();
	});

	test("no-arg accessors default to the renderSid bucket (display path)", () => {
		setLoopRenderSid("display");
		// no-arg writes the renderSid bucket
		getLoopState().consecutiveStuck = 3;
		// an explicit other-sid write must not leak into the display bucket
		getLoopState("other").consecutiveStuck = 9;
		expect(getLoopState().consecutiveStuck).toBe(3);
		expect(getLoopState("other").consecutiveStuck).toBe(9);
	});
});
