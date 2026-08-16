// src/loop/__tests__/loop-commands.test.ts
import { test, expect } from "bun:test";
import { parseLoopCommand, parseDuration } from "../loop-commands.js";

test("start with measure -> metric mode", () => {
	const r = parseLoopCommand('start "harden security" measure="bun test | grep -c passing"');
	expect(r).toMatchObject({ kind: "start", mode: "metric", target: "harden security", direction: "higher" });
});

test("start without measure -> metricless (Sisyphus)", () => {
	const r = parseLoopCommand('start "improve the spec"');
	expect(r).toMatchObject({ kind: "start", mode: "metricless", target: "improve the spec" });
});

test("direction + max + tokens + plateau parsed", () => {
	const r: any = parseLoopCommand('start "t" measure="m" direction=lower max=10 tokens=100k plateau=3');
	expect(r.direction).toBe("lower");
	expect(r.maxIterations).toBe(10);
	expect(r.tokenBudget).toBe(100_000);
	expect(r.plateauWindow).toBe(3);
});

test("time duration parses h/m", () => {
	expect(parseDuration("2h")).toBe(2 * 60 * 60_000);
	expect(parseDuration("30m")).toBe(30 * 60_000);
	expect(parseDuration("bad")).toBeUndefined();
});

test("stop / status subcommands", () => {
	expect(parseLoopCommand("stop")).toMatchObject({ kind: "stop" });
	expect(parseLoopCommand("status")).toMatchObject({ kind: "show" });
	expect(parseLoopCommand("")).toMatchObject({ kind: "show" });
});

test("start requires a target", () => {
	expect(parseLoopCommand("start")).toMatch(/Usage/);
	expect(parseLoopCommand('start measure="m"')).toMatch(/Usage/);
});
