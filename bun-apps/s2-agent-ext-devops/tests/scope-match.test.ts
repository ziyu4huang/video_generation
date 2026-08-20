/**
 * Unit tests for matchesScope — the scope-entry semantics behind
 * verify_merge_landed's CLEAN/CONTAMINATED verdict.
 *
 * History: the check used to be literal `startsWith`, so the glob-style entries
 * every caller actually passes (`bun-apps/<pkg>/**`) never matched a real path
 * and every clean merge reported CONTAMINATED (PRs #1737, #1739).
 */
import { test, expect, describe } from "bun:test";
import { matchesScope } from "../src/scope-match.js";

describe("matchesScope — x/** (directory prefix, any depth)", () => {
	test("matches a deep path under the prefix", () => {
		expect(matchesScope("bun-apps/foo/src/deep/x.ts", "bun-apps/foo/**")).toBe(true);
	});
	test("matches a direct child", () => {
		expect(matchesScope("bun-apps/foo/package.json", "bun-apps/foo/**")).toBe(true);
	});
	test("rejects a pseudo-prefix sibling directory", () => {
		expect(matchesScope("bun-apps/foo-bar/x.ts", "bun-apps/foo/**")).toBe(false);
	});
	test("rejects the bare directory itself as a FILE path", () => {
		expect(matchesScope("bun-apps/foo", "bun-apps/foo/**")).toBe(false);
	});
});

describe("matchesScope — x/* (single level)", () => {
	test("matches a direct child", () => {
		expect(matchesScope("bun-apps/foo/a.ts", "bun-apps/foo/*")).toBe(true);
	});
	test("rejects deeper paths", () => {
		expect(matchesScope("bun-apps/foo/src/a.ts", "bun-apps/foo/*")).toBe(false);
	});
});

describe("matchesScope — x/ and bare x", () => {
	test("trailing slash is a directory prefix", () => {
		expect(matchesScope("bun-apps/foo/src/a.ts", "bun-apps/foo/")).toBe(true);
	});
	test("bare entry matches the exact file", () => {
		expect(matchesScope("CLAUDE.md", "CLAUDE.md")).toBe(true);
	});
	test("bare entry matches paths under it as a directory", () => {
		expect(matchesScope("docs/adr/a.md", "docs/adr")).toBe(true);
	});
	test("bare entry NO LONGER matches a pseudo-prefix sibling (tightening)", () => {
		// Old startsWith behavior matched this — a false-CLEAN risk.
		expect(matchesScope("bun-apps/foo-bar/x.ts", "bun-apps/foo")).toBe(false);
	});
});
