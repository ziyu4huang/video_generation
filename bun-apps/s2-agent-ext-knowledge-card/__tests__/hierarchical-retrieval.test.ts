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
} from "../src/hierarchical-retrieval.ts";

describe("hierTokenize", () => {
	test("lowercase split, dedup, ≥2 chars, capped at 8", () => {
		expect(hierTokenize("The the flux2 seed! a of")).toEqual(["the", "flux2", "seed", "of"]);
		expect(hierTokenize("one two three four five six seven eight nine ten").length).toBe(8);
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
