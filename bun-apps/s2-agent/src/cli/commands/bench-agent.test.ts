import { describe, expect, test } from "bun:test";
import { selectConfigs, selectTasks, runDry } from "./bench-agent.ts";
import { BENCH_TASKS } from "../bench/tasks.ts";
import { DEFAULT_CONFIGS } from "../bench/core.ts";

describe("selectConfigs", () => {
	test("filter by csv ids; unknown id → throws with the legal ids", () => {
		expect(selectConfigs("5.3-high,5.3-low").map((c) => c.id)).toEqual(["5.3-high", "5.3-low"]);
		expect(() => selectConfigs("bogus")).toThrow(/5.3-high/);
	});
	test("undefined → full default matrix", () => {
		expect(selectConfigs(undefined)).toEqual(DEFAULT_CONFIGS);
	});
	test("provided-but-empty csv (only commas/spaces) → throws, not zero cells", () => {
		expect(() => selectConfigs(",")).toThrow(/no valid ids in --configs value/);
		expect(() => selectConfigs(" , ")).toThrow(/no valid ids in --configs value/);
	});
});

describe("selectTasks", () => {
	test("filter by csv ids; undefined → all", () => {
		expect(selectTasks("needle").map((t) => t.id)).toEqual(["needle"]);
		expect(selectTasks(undefined)).toEqual(BENCH_TASKS);
		expect(() => selectTasks("nope")).toThrow();
	});
	test("provided-but-empty csv → throws, not zero cells", () => {
		expect(() => selectTasks(",")).toThrow(/no valid ids in --tasks value/);
	});
});

describe("runDry", () => {
	test("copies fixtures, runs gates on canned outputs, renders a dry report, exit 0", async () => {
		const { report, cells } = await runDry();
		expect(cells).toHaveLength(3);
		expect(cells.filter((c) => c.quality?.pass).length).toBe(2); // needle+analysis canned-pass, edit canned-fail (pristine)
		expect(report).toContain("(DRY)");
	});
});
