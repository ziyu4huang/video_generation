import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIGS, extractMetrics, finalAssistantText, renderReport } from "./core.ts";

// Event-arrival durations in ms (extractMetrics no longer derives them from
// message timestamps — stream-start stamped upstream, see MetricsMessage):
// assistant1 arrived 10000ms after the user message, assistant2 8000ms after
// the toolResult. Combined with the usage below: median 9000 / p90 9800 / tok/s
// 1300·18⁻¹ all hold.
// Usage: assistant1 400 in / 800 out / 300 reasoning / 600 cacheRead / 0
// cacheWrite; assistant2 2950 in / 500 out / 200 reasoning / 3450 cacheRead /
// 100 cacheWrite — input2 is 2950 so the cache-ratio equation
// 4050/(4050+3350+100) = 4050/7500 = 0.54 holds exactly.
const MESSAGES = [
	{ role: "user", content: [{ type: "text", text: "do the task" }], timestamp: 1000 },
	{
		role: "assistant",
		content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "working" }],
		usage: { input: 400, output: 800, reasoning: 300, cacheRead: 600, cacheWrite: 0 },
		timestamp: 11000,
	},
	{ role: "toolResult", content: [], timestamp: 12000 },
	{
		role: "assistant",
		content: [{ type: "text", text: "NEEDLE-7Q4X9M2B" }],
		usage: { input: 2950, output: 500, reasoning: 200, cacheRead: 3450, cacheWrite: 100 },
		timestamp: 20000,
	},
];

describe("extractMetrics", () => {
	test("sums usage, derives turns/latency/ratios", () => {
		const m = extractMetrics(MESSAGES, 20000, [10000, 8000]);
		expect(m.turns).toBe(2);
		expect(m.inputTokens).toBe(3350);
		expect(m.outputTokens).toBe(1300);
		expect(m.reasoningTokens).toBe(500);
		// reasoning is a SUBSET of output (pi-ai contract): ratio = 500/1300.
		expect(m.reasoningRatio).toBeCloseTo(0.3846, 3);
		// cacheRead / (cacheRead + input + cacheWrite) = 4050/7500.
		expect(m.cacheHitRatio).toBeCloseTo(0.54, 2);
		// per-turn durations supplied by the caller: [10000, 8000] → median 9000, p90 9800.
		expect(m.medianTurnMs).toBe(9000);
		expect(m.p90TurnMs).toBe(9800);
		// output tokens over generation seconds: 1300 / 18s.
		expect(m.tokensPerSec).toBeCloseTo(72.2, 1);
	});
	test("empty messages + empty durations → zeroed metrics, no NaN", () => {
		const m = extractMetrics([], 1000, []);
		expect(m.turns).toBe(0);
		expect(m.medianTurnMs).toBe(0);
		expect(m.p90TurnMs).toBe(0);
		expect(m.tokensPerSec).toBe(0);
		expect(Number.isNaN(m.reasoningRatio)).toBe(false);
		expect(m.reasoningRatio).toBe(0);
	});
	test("message timestamps are IGNORED for durations (stream-start stamped upstream)", () => {
		const withTs = extractMetrics(MESSAGES, 20000, []);
		expect(withTs.medianTurnMs).toBe(0);
		expect(withTs.p90TurnMs).toBe(0);
		expect(withTs.tokensPerSec).toBe(0); // no fallback, no garbage tok/s
	});
});

describe("finalAssistantText", () => {
	test("joins text parts of the LAST assistant message, skips thinking", () => {
		expect(finalAssistantText(MESSAGES)).toBe("NEEDLE-7Q4X9M2B");
	});
	test("no assistant → empty string", () => {
		expect(finalAssistantText([{ role: "user", content: [], timestamp: 1 }])).toBe("");
	});
});

describe("DEFAULT_CONFIGS", () => {
	test("five focused configs, ids stable (flag --configs depends on them)", () => {
		expect(DEFAULT_CONFIGS.map((c) => c.id)).toEqual([
			"5.3-high", "5.3-medium", "5.3-low", "5.3-highspeed", "5.3-flash",
		]);
	});
});

describe("renderReport", () => {
	test("renders a markdown table with every cell + a per-config summary", () => {
		const r = renderReport(
			[
				{
					configId: "5.3-high", taskId: "needle", ok: true,
					metrics: extractMetrics(MESSAGES, 20000, [10000, 8000]),
					quality: { pass: true, detail: "needle exact-match" },
				},
				{
					configId: "5.3-medium", taskId: "edit", ok: false, error: "timeout",
					metrics: null, quality: null,
				},
			],
			{ startedAt: "2026-08-30T00:00:00Z", dry: false },
		);
		expect(r).toContain("# bench-agent report");
		expect(r).toContain("| 5.3-high | needle |");
		expect(r).toContain("| 5.3-medium | edit |");
		expect(r).toContain("timeout");
		expect(r).toContain("## Per-config summary");
	});
});
