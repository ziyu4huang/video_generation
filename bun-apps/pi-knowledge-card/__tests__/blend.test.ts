/**
 * Unit tests for the pure blend-score + tool-resolution helpers used by zk-ask's
 * three-way retrieval blend. The score fn is deterministic JS — extracted from
 * the prompt precisely so it can be tested without an LLM.
 */
import { test, expect, describe } from "bun:test";
import {
	rankBlendScore,
	ragToolsFor,
	RAG_TOOLS,
	RAG_TOOLS_THREE_WAY,
	buildRagTask,
	type BlendScoreParts,
} from "../extensions/pi-knowledge-card.ts";

describe("rankBlendScore — default mode (lexical + graph)", () => {
	test("matches the historical 0.7×lexical + 0.3×link formula", () => {
		// lexical 0.8, link 4 → 0.7×0.8 + 0.3×4 = 0.56 + 1.2 = 1.76
		expect(rankBlendScore({ lexical: 0.8, linkCount: 4 }, "default")).toBeCloseTo(1.76, 6);
	});

	test("semantic signal is IGNORED in default mode", () => {
		const parts: BlendScoreParts = { semantic: 0.99, lexical: 0.5, linkCount: 1 };
		// 0.7×0.5 + 0.3×1 = 0.65 — semantic 0.99 contributes nothing.
		expect(rankBlendScore(parts, "default")).toBeCloseTo(0.65, 6);
	});

	test("undefined fields contribute 0", () => {
		expect(rankBlendScore({}, "default")).toBe(0);
		expect(rankBlendScore({ lexical: 0.5 }, "default")).toBeCloseTo(0.35, 6);
		expect(rankBlendScore({ linkCount: 2 }, "default")).toBeCloseTo(0.6, 6);
	});
});

describe("rankBlendScore — three-way mode (semantic + lexical + graph)", () => {
	test("applies 0.4 / 0.3 / 0.3 weights", () => {
		// semantic 0.9, lexical 0.6, link 3 → 0.36 + 0.18 + 0.9 = 1.44
		const parts: BlendScoreParts = { semantic: 0.9, lexical: 0.6, linkCount: 3 };
		expect(rankBlendScore(parts, "three-way")).toBeCloseTo(1.44, 6);
	});

	test("semantic leads but cannot dominate — a strong graph card still ranks", () => {
		// Card A: semantic miss, strong lexical + heavy links.
		const a = rankBlendScore({ semantic: 0, lexical: 0.9, linkCount: 6 }, "three-way");
		// 0 + 0.27 + 1.8 = 2.07
		// Card B: semantic hit, nothing else.
		const b = rankBlendScore({ semantic: 0.9, lexical: 0, linkCount: 0 }, "three-way");
		// 0.36 + 0 + 0 = 0.36
		expect(a).toBeGreaterThan(b);
		expect(a).toBeCloseTo(2.07, 6);
		expect(b).toBeCloseTo(0.36, 6);
	});

	test("semantic-only card beats lexical-only card when both are weak", () => {
		// The premise of adding semantic: lexical misses the phrasing.
		const semanticHit = rankBlendScore({ semantic: 0.8 }, "three-way"); // 0.32
		const lexicalWeak = rankBlendScore({ lexical: 0.3 }, "three-way"); // 0.09
		expect(semanticHit).toBeGreaterThan(lexicalWeak);
	});

	test("three-way gives HIGHER weight to semantic than to lexical per unit", () => {
		const unitSemantic = rankBlendScore({ semantic: 1 }, "three-way");
		const unitLexical = rankBlendScore({ lexical: 1 }, "three-way");
		expect(unitSemantic).toBeCloseTo(0.4, 6);
		expect(unitLexical).toBeCloseTo(0.3, 6);
		expect(unitSemantic).toBeGreaterThan(unitLexical);
	});
});

describe("rankBlendScore — robustness", () => {
	test("clamps negative sentinel (obsidian_search score:-1) to 0", () => {
		// -1 sentinel must NOT subtract from the score.
		const withSentinel = rankBlendScore({ lexical: -1, linkCount: 2 }, "default");
		const zero = rankBlendScore({ linkCount: 2 }, "default");
		expect(withSentinel).toBe(zero);
		expect(withSentinel).toBeCloseTo(0.6, 6);
	});

	test("treats NaN/Infinity/non-finite as 0", () => {
		expect(rankBlendScore({ semantic: Number.NaN }, "three-way")).toBe(0);
		expect(rankBlendScore({ semantic: Number.POSITIVE_INFINITY }, "three-way")).toBe(0);
		expect(rankBlendScore({ lexical: "0.9" as unknown as number }, "default")).toBe(0);
	});

	test("defaults to default mode when mode omitted", () => {
		// Omitted mode → default weights (lexical-led).
		expect(rankBlendScore({ semantic: 1, lexical: 0, linkCount: 0 })).toBe(0);
		expect(rankBlendScore({ lexical: 1 })).toBeCloseTo(0.7, 6);
	});

	test("unknown mode string falls back to default weights", () => {
		expect(rankBlendScore({ lexical: 1 }, "nonsense" as never)).toBeCloseTo(0.7, 6);
	});
});

describe("ragToolsFor", () => {
	test("default returns the lexical+graph allowlist unchanged", () => {
		expect(ragToolsFor("default")).toEqual(RAG_TOOLS);
		expect(ragToolsFor()).toEqual(RAG_TOOLS); // default arg
		expect(ragToolsFor("default")).not.toContain("obsidian_semantic_search");
	});

	test("three-way unlocks obsidian_semantic_search", () => {
		const tools = ragToolsFor("three-way");
		expect(tools).toContain("obsidian_semantic_search");
		expect(tools).toEqual(RAG_TOOLS_THREE_WAY);
		// and still carries the lexical+graph set
		for (const t of RAG_TOOLS) expect(tools).toContain(t);
	});

	test("returns a fresh array (caller can mutate without side-effects)", () => {
		const a = ragToolsFor("three-way");
		a.push("MUTATED");
		expect(ragToolsFor("three-way")).not.toContain("MUTATED");
	});
});

describe("buildRagTask — blend mode prompt wiring", () => {
	const baseArgs = ["q", 2, 8, false, false, 5, 2000, false, undefined] as const;

	test("default mode: no semantic strategy, lexical+graph formula", () => {
		const task = buildRagTask(...baseArgs, "default");
		expect(task).toContain("run all 3 strategies");
		expect(task).toContain("0.7 × search_score");
		expect(task).not.toContain("obsidian_semantic_search");
		expect(task).not.toContain("three-way blend");
	});

	test("three-way mode: semantic strategy + 0.4/0.3/0.3 formula + graceful fallback", () => {
		const task = buildRagTask(...baseArgs, "three-way");
		expect(task).toContain("three-way blend");
		expect(task).toContain("obsidian_semantic_search");
		expect(task).toContain("0.4 × semantic");
		expect(task).toContain("0.3 × lexical");
		// must instruct graceful fallback when vault-mind is down
		expect(task).toContain("isError");
		expect(task.toLowerCase()).toContain("fall back");
	});

	test("three-way + retrieve-only tags each reference with source modes", () => {
		const task = buildRagTask("q", 2, 8, false, true, 5, 2000, false, undefined, "three-way");
		expect(task).toContain("[modes:");
		expect(task).toContain("Provenance");
	});

	test("default + retrieve-only does NOT add modes tag (no regression)", () => {
		const task = buildRagTask("q", 2, 8, false, true, 5, 2000, false, undefined, "default");
		expect(task).not.toContain("[modes:");
	});
});
