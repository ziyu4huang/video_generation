/**
 * Savings measurement tests (audit I-6 — net self-promotion accounting).
 *
 * The net computation is PURE (`computeNet`) → fast unit tests. The full
 * `measureSavings()` boots the schema-cost collection (~6s) → one integration
 * test with a 15s timeout (per the bun-test-timeout tool-quirk).
 */
import { describe, test, expect } from "bun:test";
import { computeNet, measureSavings, withinDriftBand, DRIFT_BAND, CLAIMED_SAVED_TOK, CLAIMED_NET_TOK, ENABLE_TOOL_OVERHEAD_TOK } from "./savings.ts";

describe("computeNet (pure — audit I-6 net accounting)", () => {
	test("net = savedTok − enableToolOverhead", () => {
		// Pure-fn fixture (inputs arbitrary, NOT the live baseline): 8054 − 243 = 7811; 7811/16635 = 47.0
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

describe("withinDriftBand (single-source-of-truth guard — pure)", () => {
	const band = DRIFT_BAND * CLAIMED_SAVED_TOK; // ±20% of 16,290 = ±3,258

	test("measured ≈ claim → within band", () => {
		expect(withinDriftBand(CLAIMED_SAVED_TOK)).toBe(true); // exact
		expect(withinDriftBand(16290)).toBe(true); // current measured gross (post ticket-02)
	});

	test("band edges are inclusive", () => {
		expect(withinDriftBand(CLAIMED_SAVED_TOK + band)).toBe(true); // upper edge
		expect(withinDriftBand(CLAIMED_SAVED_TOK - band)).toBe(true); // lower edge
		expect(withinDriftBand(CLAIMED_SAVED_TOK + band + 1)).toBe(false); // just over
		expect(withinDriftBand(CLAIMED_SAVED_TOK - band - 1)).toBe(false); // just under
	});

	test("halved savings → outside (claim gone stale)", () => {
		expect(withinDriftBand(4000)).toBe(false);
	});

	test("zai-mcp env swing (~+1.1k) stays within band", () => {
		// zai loads when ZAI_API_KEY is set — the dominant legitimate drift.
		expect(withinDriftBand(CLAIMED_SAVED_TOK + 1100)).toBe(true);
	});

	test("net band is a CONSISTENT envelope — in-band gross + in-band overhead must land in the net band", () => {
		// The net assertion may only reject a measurement its two INPUT assertions
		// also reject. Worst legit combo: gross near its upper edge (zai loaded)
		// with overhead slightly under claim → net drift ≈ gross drift + overhead
		// drift. The net band must therefore be the SUM of the input bands, not
		// DRIFT_BAND × CLAIMED_NET_TOK (which is tighter than the envelope it is
		// fed from — rejected 5.6 tok of otherwise-in-band drift on a machine with
		// ZAI_API_KEY set, failing deterministically on main, 2026-08-15).
		const netBand = DRIFT_BAND * (CLAIMED_SAVED_TOK + ENABLE_TOOL_OVERHEAD_TOK); // 2,008.6
		const grossNearEdge = CLAIMED_SAVED_TOK + DRIFT_BAND * CLAIMED_SAVED_TOK - 10; // in band
		const overheadUnderClaim = ENABLE_TOOL_OVERHEAD_TOK - 43; // in overhead band
		const net = grossNearEdge - overheadUnderClaim;
		expect(Math.abs(net - CLAIMED_NET_TOK)).toBeLessThanOrEqual(netBand); // accepted (fixed)
		expect(Math.abs(net - CLAIMED_NET_TOK)).toBeGreaterThan(DRIFT_BAND * CLAIMED_NET_TOK); // old band rejected it
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
			// Single-source-of-truth guard: measured gross within DRIFT_BAND of the
			// README claim — fails loudly if the claim goes stale (deviation > ±20%).
			expect(withinDriftBand(r.savedTok)).toBe(true);
			// Net claim guard (review #2): net = gross − overhead, so its band must be
			// the SUM of the two input bands (see the envelope unit test above) —
			// anything tighter rejects combos the input assertions already accepted.
			expect(Math.abs(r.netSavedTok - CLAIMED_NET_TOK)).toBeLessThanOrEqual(
				DRIFT_BAND * (CLAIMED_SAVED_TOK + ENABLE_TOOL_OVERHEAD_TOK),
			);
			// enable_tool overhead band — the net-drift root cause; fails if the escape
			// hatch schema bloats (±20% of the 243-tok claim).
			expect(Math.abs(r.enableToolOverhead - ENABLE_TOOL_OVERHEAD_TOK)).toBeLessThanOrEqual(
				DRIFT_BAND * ENABLE_TOOL_OVERHEAD_TOK,
			);
		},
		15000,
	); // 15s — boots buildSchemaCostReport (bun-test-timeout tool-quirk)
});
