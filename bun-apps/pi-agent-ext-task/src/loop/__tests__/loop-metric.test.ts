import { test, expect } from "bun:test";
import { parseMetric, runMeasure, MEASURE_TIMEOUT_MS } from "../loop-metric.js";

test("parseMetric returns the last numeric token", () => {
	expect(parseMetric("coverage: 42%\n")).toBe(42);
	expect(parseMetric("a 1 b 2.5 c")).toBe(2.5);
	expect(parseMetric("nothing here")).toBeNull();
	expect(parseMetric("")).toBeNull();
});

test("runMeasure parses stdout via parseMetric", async () => {
	const fakeExec = async () => ({ stdout: "failed 0 passed 7", exitCode: 0, stderr: "" });
	const api = { exec: fakeExec } as any;
	expect(await runMeasure(api, "echo 7", "/cwd")).toBe(7);
});

test("runMeasure returns null on exec failure or non-zero exit", async () => {
	const api = { exec: async () => { throw new Error("boom"); } } as any;
	expect(await runMeasure(api, "x", "/cwd")).toBeNull();
	const api2 = { exec: async () => ({ stdout: "", exitCode: 2, stderr: "err" }) } as any;
	expect(await runMeasure(api2, "x", "/cwd")).toBeNull();
});

test("MEASURE_TIMEOUT_MS is 60s", () => { expect(MEASURE_TIMEOUT_MS).toBe(60_000); });
