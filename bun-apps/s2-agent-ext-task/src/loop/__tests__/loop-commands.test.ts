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
	test("interval token without prompt is a usage error", () => {
		const r = parseLoopCommand("5m");
		expect(typeof r).toBe("string");
	});
});
