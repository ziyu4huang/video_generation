/**
 * Unit tests for the hierarchical-retrieval pure core (kcard-parity ticket 07,
 * D19/D20) — offline, deterministic. The SurrealDB-facing contract (KNN seed
 * lane, FTS lane, parent expansion, shadow-rebuild swap) is covered by the
 * live-service tests in surreal-index-live.test.ts (skipped when the local
 * SurrealDB service is down).
 */
import { test, expect, describe } from "bun:test";
import {
	hierTokenize,
	blendSeedScores,
	propagateScores,
	stemTokenOverlap,
	STEM_LANE_THRESHOLD,
	SLUG_BETA,
} from "../src/hierarchical-retrieval.ts";

describe("hierTokenize", () => {
	test("lowercase split, dedup, ≥2 chars, capped at 8, stop-words dropped (ticket 09 D23)", () => {
		// "the"/"of" are stop-words — a stop-word token FTS-matched ~1600 of
		// 2351 cards and its lexRank boost was pure noise (measured 2-query
		// hit@5 gap on the recall-audit battery).
		expect(hierTokenize("The the flux2 seed! a of")).toEqual(["flux2", "seed"]);
		expect(hierTokenize("aa bb cc dd ee ff gg hh ii jj").length).toBe(8);
		expect(hierTokenize("purify edits redraw whole region instead skin areas also").length).toBe(8);
	});
});

describe("blendSeedScores (α=0.18, mirrors the retrieveRecords blend)", () => {
	test("pure-semantic seed beats pure-lexical seed", () => {
		const s = blendSeedScores([
			{ stem: "a", lex: 1, cos: null },
			{ stem: "b", lex: 0, cos: 0.9 },
		]);
		expect(s.get("b")!).toBeGreaterThan(s.get("a")!);
	});
	test("lexical rank norm: more matched tokens rank higher", () => {
		const s = blendSeedScores([
			{ stem: "a", lex: 1, cos: null },
			{ stem: "b", lex: 0.5, cos: null },
		]);
		expect(s.get("a")!).toBeGreaterThan(s.get("b")!);
	});
	test("deterministic under input order permutation (stem-sorted ties)", () => {
		const pool = [
			{ stem: "x", lex: 1, cos: null },
			{ stem: "y", lex: 1, cos: null },
			{ stem: "z", lex: 0.5, cos: 0.7 },
		];
		const a = blendSeedScores([...pool]);
		const b = blendSeedScores([...pool].reverse());
		for (const p of pool) expect(a.get(p.stem)).toBe(b.get(p.stem));
	});
	test("absolute stem-lane term lifts a filename-naming card over a marginally closer vector (ticket 09 D23)", () => {
		// The measured failure mode this pins: rank-based lexRankNorm cannot
		// separate two top-of-pool cards (~1.0 vs 0.999), so a marginally
		// higher cos won; the β·min(ov,3)/3 term must be ABSOLUTE to flip it.
		// (The filler card keeps minMaxNorm from stretching the tiny cos gap
		// to the full range — with only two cards it would, and the test
		// would measure the normalizer, not the slug term.)
		const s = blendSeedScores([
			{ stem: "purify-redraw-not-skin-lever", lex: 0.5, cos: 0.6424, slugOv: 3 },
			{ stem: "chinese-titled-card", lex: 0.375, cos: 0.6482, slugOv: 0 },
			{ stem: "filler-card", lex: 0, cos: 0.55 },
		]);
		expect(s.get("purify-redraw-not-skin-lever")!).toBeGreaterThan(s.get("chinese-titled-card")!);
	});
	test("slugOv below STEM_LANE_THRESHOLD is gated off at the call site; β term scales with overlap", () => {
		const base = blendSeedScores([{ stem: "a", lex: 0, cos: 0.5 }], 0.18, 0);
		const ov3 = blendSeedScores([{ stem: "a", lex: 0, cos: 0.5, slugOv: 3 }], 0.18, SLUG_BETA);
		const ov2 = blendSeedScores([{ stem: "a", lex: 0, cos: 0.5, slugOv: 2 }], 0.18, SLUG_BETA);
		expect(ov3.get("a")! - base.get("a")!).toBeCloseTo(SLUG_BETA, 6);
		expect(ov2.get("a")! - base.get("a")!).toBeCloseTo((SLUG_BETA * 2) / 3, 6);
	});
});

describe("stemTokenOverlap (ticket 09 D23 stem lane)", () => {
	test("counts query tokens present in stem tokens; namespace junk never counts", () => {
		const tokens = hierTokenize("purify edits should redraw the whole region instead of only skin areas");
		expect(stemTokenOverlap("auto-memory-purify-redraw-not-skin-lever-seedvr2-2x-oom", tokens)).toBe(3);
		// auto/memory are STEM_STOP; pr/merge style namespace prefixes carry no topic signal
		expect(stemTokenOverlap("auto-memory-something-else-entirely", tokens)).toBe(0);
	});
	test("CJK stems get zero overlap against English tokens (the F8 lane gap is lexical-lane-only)", () => {
		expect(stemTokenOverlap("中文標題卡片", hierTokenize("purify redraw skin"))).toBe(0);
	});
	test("threshold sanity: a two-topic stem overlap is counted exactly (gating happens at the call site)", () => {
		// worktree + branch = 2 (deletion≠delete — no stemming on this lane);
		// below STEM_LANE_THRESHOLD=3, so this card is NOT slug-boosted live —
		// the measured flood guard (crowd cards on generic tokens, t2→t5
		// receipts: five-step regressed 2→4 at threshold 2).
		expect(stemTokenOverlap("vg-gh-pr-merge-worktree-delete-branch", hierTokenize("worktree branch deletion fails until you detach first in this repo"))).toBe(2);
	});
});

describe("propagateScores (D20 max-propagation)", () => {
	const leaf = (stem: string, seed = 0) => ({ stem, is_leaf: true, seed });
	const agg = (stem: string, seed = 0) => ({ stem, is_leaf: false, seed });

	test("γ-decayed propagation reaches leaf children of a seeded agg node", () => {
		const rows = new Map([
			["agg-L1-0", agg("agg-L1-0", 0.8)],
			["leaf-a", leaf("leaf-a")],
		]);
		const childrenOf = new Map([["agg-L1-0", ["leaf-a"]]]);
		const { best, viaTree } = propagateScores(childrenOf, rows, 0.5);
		expect(best.get("leaf-a")).toBeCloseTo(0.4, 6);
		expect(viaTree.has("leaf-a")).toBe(true);
	});

	test("max semantics: a child's own higher seed is kept (not overwritten)", () => {
		const rows = new Map([
			["agg-L1-0", agg("agg-L1-0", 0.4)],
			["leaf-a", leaf("leaf-a", 0.9)],
		]);
		const childrenOf = new Map([["agg-L1-0", ["leaf-a"]]]);
		const { best, viaTree } = propagateScores(childrenOf, rows, 0.5);
		expect(best.get("leaf-a")).toBeCloseTo(0.9, 6);
		expect(viaTree.has("leaf-a")).toBe(false);
	});

	test("multi-level decay: γ² through two agg layers", () => {
		const rows = new Map([
			["agg-L2-0", agg("agg-L2-0", 1)],
			["agg-L1-0", agg("agg-L1-0")],
			["leaf-a", leaf("leaf-a")],
		]);
		const childrenOf = new Map([
			["agg-L2-0", ["agg-L1-0"]],
			["agg-L1-0", ["leaf-a"]],
		]);
		const { best, sweeps } = propagateScores(childrenOf, rows, 0.5);
		expect(best.get("agg-L1-0")).toBeCloseTo(0.5, 6);
		expect(best.get("leaf-a")).toBeCloseTo(0.25, 6);
		expect(sweeps).toBe(2);
	});

	test("cycle guard: a parent cycle terminates within maxSweeps", () => {
		const rows = new Map([
			["a", agg("a", 1)],
			["b", agg("b")],
		]);
		const childrenOf = new Map([
			["a", ["b"]],
			["b", ["a"]], // cycle — must not hang
		]);
		const { sweeps } = propagateScores(childrenOf, rows, 0.9, 3);
		expect(sweeps).toBeLessThanOrEqual(3);
	});

	test("leaves never expand; children outside the row set are ignored", () => {
		const rows = new Map([
			["agg-L1-0", agg("agg-L1-0", 1)],
			["leaf-a", leaf("leaf-a")],
		]);
		const childrenOf = new Map([
			["agg-L1-0", ["leaf-a", "ghost"]], // ghost not in rowsByStem
			["leaf-a", ["agg-L1-0"]], // leaf "expansion" must be ignored
		]);
		const { best, expanded } = propagateScores(childrenOf, rows, 0.5);
		expect(best.get("ghost")).toBeUndefined();
		expect(expanded).toBe(1);
	});
});
