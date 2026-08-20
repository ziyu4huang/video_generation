/**
 * A0.3 — fuzzyMatch tests.
 *   bun test extensions/__tests__/fuzzyMatch.test.mjs
 *
 * Validates: tolerance boundaries (len ≤3/≤6/>6), exact-substring fast path,
 * subsequence across whitespace, no-match.
 */
import { describe, it, expect } from "bun:test";
import { fuzzyMatch } from "../obsidian.ts";

describe("fuzzyMatch — exact substring fast path", () => {
	it("returns true when query is an exact substring (any tolerance)", () => {
		expect(fuzzyMatch("hello obsidian world", "obsidian", 0)).toBe(true);
		expect(fuzzyMatch("hello obsidian world", "obsidian", 1)).toBe(true);
		expect(fuzzyMatch("hello obsidian world", "obsidian", 2)).toBe(true);
	});

	it("empty query returns false (matches nothing)", () => {
		expect(fuzzyMatch("anything", "", 0)).toBe(false);
		expect(fuzzyMatch("anything", "", 2)).toBe(false);
	});
});

describe("fuzzyMatch — tolerance 0 (subsequence only)", () => {
	it("matches an ordered subsequence (chars in order, not contiguous)", () => {
		// "obsidian" as subsequence of "o b s i d i a n"
		expect(fuzzyMatch("o b s i d i a n", "obsidian", 0)).toBe(true);
	});

	it("matches subsequence across spaces and mixed content", () => {
		expect(fuzzyMatch("only blue sky", "obs", 0)).toBe(true); // o-b-s out of "only blue sky"? no
	});

	it("subsequence across real words", () => {
		// fuzzyMatch is case-sensitive; buildMatcher does the lowercasing.
		// 'od' from "obsidian design" (lowercased)
		expect(fuzzyMatch("obsidian design", "od", 0)).toBe(true);
	});

	it("returns false when chars not in order", () => {
		expect(fuzzyMatch("world", "dlrow", 0)).toBe(false);
	});
});

describe("fuzzyMatch — tolerance boundaries by query length", () => {
	// Mirrors buildMatcher("fuzzy") tolerance: len ≤3 → 0, ≤6 → 1, else 2.

	it("len ≤3 → tolerance 0: single typo NOT tolerated", () => {
		// query "abc" (len 3) → tol 0. "axc" differs by 1 edit, should NOT match at tol 0.
		expect(fuzzyMatch("axc", "abc", 0)).toBe(false);
	});

	it("len ≤6 → tolerance 1: single typo tolerated", () => {
		// query "agentc" (len 6) vs "agentic" — 1 insertion. tol 1 should match.
		expect(fuzzyMatch("this is agentic stuff", "agentc", 1)).toBe(true);
	});

	it("len >6 → tolerance 2: two edits tolerated", () => {
		// query "obsidan" (len 7, missing 'i') vs "obsidian" — 1 deletion → within tol 2.
		expect(fuzzyMatch("obsidian", "obsidan", 2)).toBe(true);
		// query "obsidxx" vs "obsidian" — 2 char diff, within tol 2 via windowing
		expect(fuzzyMatch("obsidian here", "obsidxx", 2)).toBe(true);
	});

	it("tolerance not exceeded: large diff returns false", () => {
		// "zzzzzz" vs "obsidian" — totally different, even tol 2 won't match
		expect(fuzzyMatch("obsidian", "zzzzzz", 2)).toBe(false);
	});
});

describe("fuzzyMatch — no false positives", () => {
	it("unrelated text does not match", () => {
		expect(fuzzyMatch("completely different content", "zzznomatch", 2)).toBe(false);
	});

	it("query longer than line returns false", () => {
		expect(fuzzyMatch("hi", "obsidian", 2)).toBe(false);
	});
});
