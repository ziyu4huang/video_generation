/**
 * hotness.test.ts — ticket 08 pure-function contracts (D37–D39).
 *
 * Deterministic: no network, no Surreal, no files. Pins:
 *  - the OpenViking-parity formula (sigmoid(log1p(active_count))·exp decay,
 *    half-life 7d) + the D39 anchor max(mtime, last_use),
 *  - the D37 ±10% bound mechanics (relative-score clamp, β=0.1),
 *  - the fold's determinism contract (sticky pre-fold ties, neutral band).
 */
import { test, expect, describe } from "bun:test";
import {
	HOTNESS_BOUND_BETA,
	HOTNESS_NEUTRAL_EPSILON,
	clampWithHotness,
	hotnessScore,
	rankWithHotness,
	type HotnessEntry,
	type UsageStats,
} from "../src/hotness.ts";
import { HOTNESS_HALF_LIFE_DAYS } from "../src/hotness.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = 1_800_000_000_000; // fixed epoch ms (deterministic)
const ageMs = (days: number) => Math.round(NOW - days * DAY);

describe("hotnessScore (OpenViking-parity formula)", () => {
	test("sigmoid(log1p(0)) = 0.5 — untouched cards baseline half", () => {
		expect(hotnessScore(0, null, NOW, NOW)).toBe(0.5);
	});

	test("frequency grows with active_count and saturates below 1", () => {
		const h0 = hotnessScore(0, null, NOW, NOW);
		const h1 = hotnessScore(1, null, NOW, NOW);
		const h10 = hotnessScore(10, null, NOW, NOW);
		const h100 = hotnessScore(100, null, NOW, NOW);
		expect(h0).toBeLessThan(h1);
		expect(h1).toBeLessThan(h10);
		expect(h10).toBeLessThan(h100);
		expect(h100).toBeLessThan(1);
		// sigmoid(log1p(10)) — sigmoid(ln(11)) = 11/12 ≈ 0.9167
		expect(h10).toBeCloseTo(11 / 12, 3);
	});

	test("half-life 7d — a 7-day-old card decays to exactly half", () => {
		const now = NOW;
		const h0 = hotnessScore(0, null, now, now); // age 0
		const h7 = hotnessScore(0, null, ageMs(7), now); // age 7d
		expect(h0).toBeCloseTo(0.5, 12);
		expect(h7).toBeCloseTo(0.5 * 0.5, 12);
		// decay_rate = ln2 / half_life
		expect(HOTNESS_HALF_LIFE_DAYS).toBe(7);
	});

	test("anchor = max(mtime, last_use) (D39) — a fresher usage wins", () => {
		// mtime 21d old, last_use 3d ago → anchor 3d → decay = 2^-3/7
		const h = hotnessScore(0, ageMs(3), ageMs(21), NOW);
		expect(h).toBeCloseTo(0.5 * 2 ** (-3 / 7), 12);
		// last_use older than mtime → mtime wins
		const hAlt = hotnessScore(0, ageMs(21), ageMs(3), NOW);
		expect(hAlt).toBeCloseTo(0.5 * 2 ** (-3 / 7), 12);
	});

	test("future timestamps clamp to age 0; no anchor → 0", () => {
		const future = NOW + 10 * DAY;
		expect(hotnessScore(0, future, future, NOW)).toBeCloseTo(0.5, 12);
		expect(hotnessScore(0, null, 0, NOW)).toBe(0);
	});
});

describe("clampWithHotness (D37 ±10% bound)", () => {
	test("β bound: h=1 → ×(1+β); h=0 → ×(1−β); h=0.5 → ×1", () => {
		expect(clampWithHotness(1.0, 1)).toBeCloseTo(1 + HOTNESS_BOUND_BETA, 12);
		expect(clampWithHotness(1.0, 0)).toBeCloseTo(1 - HOTNESS_BOUND_BETA, 12);
		expect(clampWithHotness(1.0, 0.5)).toBeCloseTo(1.0, 12);
	});
	test("a zero score stays zero — hotness can never dominate", () => {
		expect(clampWithHotness(0, 1)).toBe(0);
	});
	test("every final within [0.9·score, 1.1·score]", () => {
		for (const h of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
			const s = 0.9;
			const f = clampWithHotness(s, h);
			expect(f).toBeGreaterThanOrEqual(0.9 * s - 1e-12);
			expect(f).toBeLessThanOrEqual(1.1 * s + 1e-12);
		}
	});
});

const entry = (stem: string, score: number, mtimeMs = NOW): HotnessEntry => ({ stem, score, mtimeMs });

describe("rankWithHotness (fold contract)", () => {
	test("a heavily-used fresh card overtakes a near-tie cold card", () => {
		const stats: UsageStats = new Map([
			// hot: freq sigmoid(log1p(50)) = 51/52 ≈ 0.981, decay(0.1d) ≈ 0.99 → h ≈ 0.971
			["hot", { count: 50, lastUseMs: ageMs(0.1) }],
		]);
		const folded = rankWithHotness(
			[entry("cold", 0.8, ageMs(30)), entry("hot", 0.7, ageMs(30))],
			stats,
			NOW,
		);
		// hot: 0.7·1.094 ≈ 0.766 > cold: 0.8·0.905 ≈ 0.724 — a near-tie re-rank
		expect(folded[0]!.stem).toBe("hot");
		expect(folded[0]!.factor).toBeLessThanOrEqual(1.1);
		expect(folded[0]!.factor).toBeGreaterThanOrEqual(0.9);
		expect(folded[1]!.stem).toBe("cold");
	});

	test("bounded: fold never moves a card outside its ±β band", () => {
		const stats: UsageStats = new Map([
			["a", { count: 1000, lastUseMs: ageMs(0.01) }],
			["b", { count: 0, lastUseMs: null }],
		]);
		const folded = rankWithHotness([entry("a", 0.5), entry("b", 0.5)], stats, NOW);
		for (const f of folded) {
			expect(f.finalScore).toBeGreaterThanOrEqual(0.5 * 0.9 - 1e-9);
			expect(f.finalScore).toBeLessThanOrEqual(0.5 * 1.1 + 1e-9);
		}
	});

	test("exact ties keep pre-fold order (sticky)", () => {
		const folded = rankWithHotness([entry("b", 0.5), entry("a", 0.5)], new Map(), NOW);
		expect(folded.map((f) => f.stem)).toEqual(["b", "a"]); // NO re-tie-break
	});

	test("neutral band: |h−0.5| ≤ ε → identity (unfolded, exact score)", () => {
		// age ~0 with zero usage: h ≈ 0.5 (within ε) → factor 1, score preserved EXACTLY
		const folded = rankWithHotness([entry("a", 0.123456789012345), entry("b", 0.2)], new Map(), NOW);
		const a = folded.find((f) => f.stem === "a")!;
		expect(a.factor).toBe(1);
		expect(a.finalScore).toBe(0.123456789012345);
	});

	test("neutral band is a real cutoff — old cards still fold", () => {
		// age 30d (decay ≈ 0.052) → h ≈ 0.026 → |h−0.5| > ε → folds (down)
		const stats = new Map<string, { count: number; lastUseMs: number | null }>();
		const folded = rankWithHotness([entry("old", 0.8, ageMs(30))], stats, NOW);
		expect(folded[0]!.factor).toBeLessThan(1);
		expect(folded[0]!.factor).toBeGreaterThanOrEqual(0.9);
	});

	test("ε is the documented 0.001", () => {
		expect(HOTNESS_NEUTRAL_EPSILON).toBe(0.001);
	});
});
