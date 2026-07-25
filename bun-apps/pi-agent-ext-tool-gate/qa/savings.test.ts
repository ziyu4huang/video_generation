/**
 * Savings measurement tests (audit I-6 — net self-promotion accounting).
 *
 * The net computation is PURE (`computeNet`) → fast unit tests. The full
 * `measureSavings()` boots the schema-cost collection (~6s) → one integration
 * test with a 15s timeout (per the bun-test-timeout tool-quirk).
 */
import { describe, test, expect } from "bun:test";
import { computeNet, measureSavings } from "./savings.ts";

describe("computeNet (pure — audit I-6 net accounting)", () => {
	test("net = savedTok − enableToolOverhead", () => {
		// 8054 gross − 243 enable_tool = 7811 net; 7811/16635 = 46.96% → 47.0
		expect(computeNet(8054, 243, 16635)).toEqual({ netSavedTok: 7811, netSavedPct: 47 });
	});

	test("zero overhead → net equals gross", () => {
		expect(computeNet(1000, 0, 2000)).toEqual({ netSavedTok: 1000, netSavedPct: 50 });
	});

	test("overhead exceeding saved → negative net (honest red flag, NOT clamped)", () => {
		// If the escape hatch ever costs more than the gate saves, net goes
		// negative — that is a real signal, not something to hide behind max(0).
		const r = computeNet(100, 300, 1000);
		expect(r.netSavedTok).toBe(-200);
		expect(r.netSavedPct).toBe(-20);
	});

	test("offTotal 0 → netSavedPct 0 (no div-by-zero)", () => {
		expect(computeNet(500, 100, 0)).toEqual({ netSavedTok: 400, netSavedPct: 0 });
	});
});

describe("measureSavings (integration — reports net + overhead, audit I-6)", () => {
	test(
		"enable_tool overhead is measured; net < gross; net = saved − overhead",
		async () => {
			const r = await measureSavings();
			// enable_tool is captured (tool-gate registers it) → overhead > 0.
			expect(r.enableToolOverhead).toBeGreaterThan(0);
			// The I-6 invariant: net is exactly gross minus the measured overhead.
			expect(r.netSavedTok).toBe(r.savedTok - r.enableToolOverhead);
			expect(r.netSavedTok).toBeLessThan(r.savedTok);
			expect(r.netSavedPct).toBeLessThan(r.savedPct);
			// Sanity: we still save a lot (gross floor holds).
			expect(r.savedTok).toBeGreaterThan(5000);
		},
		15000,
	); // 15s — boots buildSchemaCostReport (bun-test-timeout tool-quirk)
});
