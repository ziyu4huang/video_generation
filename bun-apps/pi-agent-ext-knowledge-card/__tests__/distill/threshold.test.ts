import { test, expect, describe } from "bun:test";
import { adjustThreshold } from "../../src/distill/threshold.ts";
import type { ConvergeMetrics } from "../../src/distill/types.ts";

describe("adaptive threshold", () => {
	test("efficient pipeline (high kill + high pass) lowers N by 5", () => {
		const m: ConvergeMetrics = { candidates: 100, killed: 75, survivors: 25 };
		const result = adjustThreshold(m, 50, 23); // passRate = 23/25 = 0.92
		expect(result.newN).toBe(45);
		expect(result.delta).toBe(-5);
		expect(result.reason).toContain("efficient");
	});

	test("poor quality (low pass) raises N by 10", () => {
		const m: ConvergeMetrics = { candidates: 100, killed: 30, survivors: 70 };
		const result = adjustThreshold(m, 50, 20); // passRate = 20/70 ≈ 0.29
		expect(result.newN).toBe(60);
		expect(result.delta).toBe(10);
		expect(result.reason).toContain("conservative");
	});

	test("stable regime (moderate rates) keeps N unchanged", () => {
		const m: ConvergeMetrics = { candidates: 100, killed: 50, survivors: 50 };
		const result = adjustThreshold(m, 50, 40); // killRate 0.5, passRate 0.8
		expect(result.newN).toBe(50);
		expect(result.delta).toBe(0);
		expect(result.reason).toContain("stable");
	});

	test("clamps to min 20", () => {
		const m: ConvergeMetrics = { candidates: 100, killed: 90, survivors: 10 };
		const result = adjustThreshold(m, 22, 10); // would go to 17
		expect(result.newN).toBe(20);
	});

	test("clamps to max 200", () => {
		const m: ConvergeMetrics = { candidates: 100, killed: 10, survivors: 90 };
		const result = adjustThreshold(m, 195, 10); // passRate 0.11, would go to 205
		expect(result.newN).toBe(200);
	});

	test("zero survivors (all killed) does not crash", () => {
		const m: ConvergeMetrics = { candidates: 100, killed: 100, survivors: 0 };
		const result = adjustThreshold(m, 50, 0);
		expect(result.newN).toBeGreaterThanOrEqual(20);
	});
});
