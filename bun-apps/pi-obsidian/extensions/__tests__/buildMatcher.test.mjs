/**
 * A0.2 — buildMatcher tests (all 4 modes).
 *   bun test extensions/__tests__/buildMatcher.test.mjs
 */
import { describe, it, expect } from "bun:test";
import { buildMatcher } from "../obsidian.ts";

// helper: run a matcher over an array of lines, return matched indices
function indices(match, lines) {
	const out = [];
	for (let i = 0; i < lines.length; i++) if (match(lines[i])) out.push(i);
	return out;
}

// helper: assert fileFilter is present and return it as a callable (no TS non-null)
function ff(built) {
	if (typeof built.fileFilter !== "function") throw new Error("expected fileFilter to be a function");
	return built.fileFilter;
}

describe("buildMatcher — substring mode", () => {
	it("is byte-identical to old lowercased-includes when caseSensitive=false", () => {
		const lines = ["Hello World", "hello world", "HELLO", "nope", "WorLd"];
		const { match } = buildMatcher("world", "substring", false);
		// old impl: lowercased includes
		const old = indices((l) => l.toLowerCase().includes("world"), lines);
		expect(indices(match, lines)).toEqual(old);
		expect(indices(match, lines)).toEqual([0, 1, 4]);
	});

	it("respects caseSensitive=true", () => {
		const lines = ["World", "world", "WORLD"];
		const cs = buildMatcher("World", "substring", true).match;
		expect(indices(cs, lines)).toEqual([0]);
		const ci = buildMatcher("World", "substring", false).match;
		expect(indices(ci, lines)).toEqual([0, 1, 2]);
	});

	it("empty query matches everything (byte-identical to old String.includes(''))", () => {
		// Old impl: hay.includes('') is true for any string → all lines match.
		const { match } = buildMatcher("", "substring", false);
		expect(match("anything")).toBe(true);
		expect(match("")).toBe(true);
	});
});

describe("buildMatcher — regex mode", () => {
	it("matches alternation", () => {
		const { match } = buildMatcher("foo|bar", "regex", false);
		expect(match("this is foo")).toBe(true);
		expect(match("this is bar")).toBe(true);
		expect(match("this is baz")).toBe(false);
	});

	it("anchored regex only matches at start", () => {
		const { match } = buildMatcher("^#\\s+", "regex", false);
		expect(match("# heading")).toBe(true);
		expect(match("text # not heading")).toBe(false);
	});

	it("invalid regex returns {error} and never throws", () => {
		const built = buildMatcher("(unclosed", "regex", false);
		expect(built.error).toBeTruthy();
		expect(built.match).toBeUndefined();
		// constructing must not throw
		expect(() => buildMatcher("*invalid", "regex", false)).not.toThrow();
	});
});

describe("buildMatcher — words mode", () => {
	const lines = [
		"obsidian agent package", // 0: has all three
		"obsidian agent", // 1: obsidian + agent
		"obsidian package", // 2: obsidian + package
		"agent package", // 3: agent + package
		"nothing here", // 4: none
		"agent", // 5: agent only
	];

	it("AND: tokens must all be present", () => {
		const { match } = buildMatcher("obsidian agent", "words", false);
		expect(indices(match, lines)).toEqual([0, 1]);
	});

	it("OR group: | separates alternatives", () => {
		const { match } = buildMatcher("zzz | obsidian", "words", false);
		// obsidian present on 0,1,2; zzz on none
		expect(indices(match, lines)).toEqual([0, 1, 2]);
	});

	it("NOT terms are exposed via fileFilter (not match)", () => {
		// PR #9 contract: NOT exclusion is file-level, returned as `fileFilter`,
		// NOT applied inside `match`. So match alone returns the positive hits.
		const built = buildMatcher("obsidian -package", "words", false);
		expect(built.fileFilter).toBeTruthy();
		expect(typeof built.fileFilter).toBe("function");
		// match alone returns obsidian lines [0,1,2] (NOT not applied here)
		expect(indices(built.match, lines)).toEqual([0, 1, 2]);
		// fileFilter rejects content containing any negative term
		expect(ff(built)("obsidian agent package")).toBe(false); // has 'package'
		expect(ff(built)("obsidian agent")).toBe(true); // no 'package'
	});

	it("NOT-only query: match is vacuous, fileFilter does the exclusion", () => {
		const built = buildMatcher("-obsidian", "words", false);
		expect(built.fileFilter).toBeTruthy();
		// no positives → match returns true for every line (vacuous AND)
		expect(indices(built.match, lines)).toEqual([0, 1, 2, 3, 4, 5]);
		// fileFilter excludes any content containing 'obsidian'
		expect(ff(built)("has obsidian here")).toBe(false);
		expect(ff(built)("no relevant term")).toBe(true);
	});

	it("AND + NOT: match does AND of positives, fileFilter excludes negatives", () => {
		const built = buildMatcher("agent -package", "words", false);
		expect(built.fileFilter).toBeTruthy();
		// match: agent on 0,1,3,5
		expect(indices(built.match, lines)).toEqual([0, 1, 3, 5]);
		// fileFilter excludes content with 'package'
		expect(ff(built)("agent package")).toBe(false);
		expect(ff(built)("agent only")).toBe(true);
	});
});

describe("buildMatcher — fuzzy mode", () => {
	it("exact substring fast-path always matches", () => {
		const { match } = buildMatcher("obsidian", "fuzzy", false);
		expect(match("hello obsidian world")).toBe(true);
	});

	it("tolerates 1-char typo for queries >3 chars", () => {
		// "agentc" vs "agentic": 1 transposition/edit, tol should be ≥1 for len 6
		const { match } = buildMatcher("agentc", "fuzzy", false);
		expect(match("this is agentic stuff")).toBe(true);
	});

	it("case-insensitive by default", () => {
		const { match } = buildMatcher("obsidian", "fuzzy", false);
		expect(match("OBSIDIAN")).toBe(true);
	});

	it("no false positives on unrelated text", () => {
		const { match } = buildMatcher("zzznomatch", "fuzzy", false);
		expect(match("completely different content")).toBe(false);
	});
});

describe("buildMatcher — unknown mode", () => {
	it("returns {error} for unknown mode", () => {
		const mode = "nonsense";
		const built = buildMatcher("x", mode, false);
		expect(built.error).toBeTruthy();
		expect(built.match).toBeUndefined();
	});
});
