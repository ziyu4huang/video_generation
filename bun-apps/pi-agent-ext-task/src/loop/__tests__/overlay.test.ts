import { test, expect } from "bun:test";
import { LoopOverlay } from "../overlay.js";
import { createLoop, applyMeasurement } from "../loop-state.js";

const T = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as any;

test("render empty when no loop and no flash", () => {
	expect(new LoopOverlay().render(T, 80)).toEqual([]);
});

test("metric render shows iteration, best, stall", () => {
	const o = new LoopOverlay();
	let l = createLoop({ target: "harden", mode: "metric", measureCmd: "c", direction: "higher", plateauWindow: 5 });
	l = applyMeasurement(l, 7, "h1");
	o.update(l);
	const line = o.render(T, 80).join(" ");
	expect(line).toContain("#1");
	expect(line).toContain("best=7");
	expect(line).toContain("0/5");
});

test("metricless render shows iteration + metricless tag", () => {
	const o = new LoopOverlay();
	const l = createLoop({ target: "polish", mode: "metricless" });
	o.update({ ...l, iteration: 3 });
	const line = o.render(T, 80).join(" ");
	expect(line).toContain("#4"); // iteration is 0-based, display iteration+1
	expect(line).toContain("metricless");
});

test("showStop flash renders + auto-clears via dispose", () => {
	const o = new LoopOverlay();
	o.showStop("plateau");
	expect(o.render(T, 80).join(" ")).toContain("loop stopped");
	o.dispose();
});
