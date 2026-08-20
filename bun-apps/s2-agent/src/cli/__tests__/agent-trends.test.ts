/**
 * Tests for agent-trends formatting.
 *
 * The filesystem wiring is exercised live against the real archive; these cover
 * the pure formatting decisions, above all that an unmeasurable metric is never
 * printed as a zero and a suppressed verdict is never printed as a direction.
 */
import { test, expect, describe } from "bun:test";
import { formatTrendReport } from "../commands/agent-trends.ts";

const base = {
	totalSessions: 400,
	windows: 2,
	series: [
		{
			check: "consecutive-error",
			points: [
				{ window: 0, sessions: 200, occurrences: 20, ratePct: 10 },
				{ window: 1, sessions: 200, occurrences: 60, ratePct: 30 },
			],
		},
	],
	verdicts: [
		{
			check: "consecutive-error",
			baselineRatePct: 10,
			recentRatePct: 30,
			deltaPct: 20,
			volatilityPct: 0,
			thresholdPct: 10,
			baselineEvents: 20,
			verdict: "regressed" as const,
		},
	],
};

describe("formatTrendReport", () => {
	test("prints the regression direction", () => {
		const text = formatTrendReport(base, { unmeasurableSessions: 0 }).join("\n");
		expect(text).toContain("consecutive-error");
		expect(text).toContain("regressed");
	});

	test("prints insufficient-signal instead of a direction", () => {
		const report = {
			...base,
			verdicts: [
				{ ...base.verdicts[0]!, baselineEvents: 2, verdict: "insufficient-signal" as const },
			],
		};
		const text = formatTrendReport(report, { unmeasurableSessions: 0 }).join("\n");
		expect(text).toContain("insufficient signal");
		expect(text).not.toContain("regressed");
	});

	test("names the threshold the verdict was measured against", () => {
		const text = formatTrendReport(base, { unmeasurableSessions: 0 }).join("\n");
		expect(text).toContain("vs 10pp");
		expect(text).toContain("floor");
	});

	test("says when a check was judged against its own volatility", () => {
		const report = {
			...base,
			verdicts: [{ ...base.verdicts[0]!, volatilityPct: 40, thresholdPct: 40, verdict: "stable" as const }],
		};
		const text = formatTrendReport(report, { unmeasurableSessions: 0 }).join("\n");
		expect(text).toContain("vs 40pp own volatility");
		expect(text).not.toContain("floor");
	});

	test("discloses how many sessions were unmeasurable", () => {
		const text = formatTrendReport(base, { unmeasurableSessions: 533 }).join("\n");
		expect(text).toContain("533");
		expect(text).toContain("unmeasurable");
	});

	test("says so plainly when there is not enough history for any window", () => {
		const text = formatTrendReport(
			{ totalSessions: 12, windows: 1, series: [], verdicts: [] },
			{ unmeasurableSessions: 0 },
		).join("\n");
		expect(text).toContain("not enough history");
	});
});
