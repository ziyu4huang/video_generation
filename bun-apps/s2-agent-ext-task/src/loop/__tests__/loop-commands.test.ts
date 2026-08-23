/** /loop CC-syntax parsing — [interval] <prompt…>, default 10m, s rounds up. */
import { test, expect, describe } from "bun:test";
import { parseLoopCommand, parseInterval } from "../loop-commands.js";

describe("parseInterval", () => {
	test("units s/m/h/d", () => {
		expect(parseInterval("120s")).toBe(120_000);
		expect(parseInterval("5m")).toBe(300_000);
		expect(parseInterval("1h")).toBe(3_600_000);
		expect(parseInterval("1d")).toBe(86_400_000);
	});
	test("seconds round UP to a whole minute (CC)", () => {
		expect(parseInterval("1s")).toBe(60_000);
		expect(parseInterval("45s")).toBe(60_000);
		expect(parseInterval("61s")).toBe(120_000);
	});
	test("junk rejected", () => {
		expect(parseInterval("5x")).toBeUndefined();
		expect(parseInterval("m5")).toBeUndefined();
		expect(parseInterval("")).toBeUndefined();
	});
	test("0m/0h/0d floor to the 60s minimum (all units clamp)", () => {
		expect(parseInterval("0m")).toBe(60_000);
		expect(parseInterval("0h")).toBe(60_000);
		expect(parseInterval("0d")).toBe(60_000);
		expect(parseInterval("0s")).toBe(60_000);
	});
	test("huge values clamp to the timer-safety cap (setTimeout 2^31-1 bound)", () => {
		expect(parseInterval("999999999d")).toBe(2_000_000_000);
		expect(parseInterval("999999999h")).toBe(2_000_000_000);
		expect(parseInterval("99999999m")).toBe(2_000_000_000);
	});
	test("in-range values for every unit are unchanged by the clamp", () => {
		expect(parseInterval("1d")).toBe(86_400_000);
		expect(parseInterval("1h")).toBe(3_600_000);
		expect(parseInterval("1m")).toBe(60_000);
	});
});

describe("parseLoopCommand", () => {
	test("interval + prompt", () => {
		const r = parseLoopCommand("5m check the deploy");
		expect(r).toEqual({ kind: "start", intervalMs: 300_000, prompt: "check the deploy" });
	});
	test("prompt only defaults to 10m", () => {
		const r = parseLoopCommand("babysit the PR queue");
		expect(r).toEqual({ kind: "start", intervalMs: 600_000, prompt: "babysit the PR queue" });
	});
	test("d-unit prompt target", () => {
		const r = parseLoopCommand("1d /daily-summary");
		expect(r).toEqual({ kind: "start", intervalMs: 86_400_000, prompt: "/daily-summary" });
	});
	test("stop / status / empty", () => {
		expect(parseLoopCommand("stop")).toEqual({ kind: "stop" });
		expect(parseLoopCommand("status")).toEqual({ kind: "show" });
		expect(parseLoopCommand("")).toEqual({ kind: "show" });
		expect(typeof parseLoopCommand("stop extra")).toBe("string");
	});
	test("old process-loop syntax gets a usage pointer", () => {
		const r = parseLoopCommand('start "improve x" measure="echo 1"');
		expect(typeof r).toBe("string");
		expect(r).toContain("/loop <interval> <prompt>");
	});
	test("old syntax detected with quote or measure= right after 'start'", () => {
		expect(typeof parseLoopCommand('start "improve x"')).toBe("string");
		expect(typeof parseLoopCommand("start measure=echo")).toBe("string");
	});
	test("prompt merely beginning with 'start' is a normal recurring target", () => {
		const r = parseLoopCommand("start the servers");
		expect(r).toEqual({ kind: "start", intervalMs: 600_000, prompt: "start the servers" });
	});
	test("interval token without prompt is a usage error", () => {
		const r = parseLoopCommand("5m");
		expect(typeof r).toBe("string");
	});
	test("'dynamic'/'off' point at the subagent-side /loop:2 instead of mis-scheduling (t03/B4)", () => {
		const r1 = parseLoopCommand("dynamic watch the deploy");
		expect(typeof r1).toBe("string");
		expect(r1).toContain("/loop:2");
		const r2 = parseLoopCommand("off");
		expect(typeof r2).toBe("string");
		expect(r2).toContain("/loop:2");
	});
});
