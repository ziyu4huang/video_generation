/**
 * ext-build — unit tests for the pure helpers.
 *
 * extractBareSpecifiers scans minified bundle output for ESM bare specifiers
 * (the things Gate 1 checks against the host whitelist). It MUST NOT match a
 * `from` that is merely a substring of a larger token — e.g. the `from` inside
 * `"sql-delete-from"`, which a naive /from\s*["']/ regex misreads and then
 * fails to resolve, breaking the whole deploy. These cases moved here with the
 * function when the legacy build-extensions.ts was retired.
 */
import { describe, expect, test } from "bun:test";
import { extractBareSpecifiers } from "./ext-build.ts";

describe("extractBareSpecifiers", () => {
	test("extracts real ESM bare specifiers", () => {
		const code = `
			import { XMLParser } from "fast-xml-parser";
			import foo from "typebox";
			const dyn = import("node:fs");
			export { x } from "@earendil-works/pi-ai";
		`;
		const specs = extractBareSpecifiers(code);
		expect(specs).toContain("fast-xml-parser");
		expect(specs).toContain("typebox");
		expect(specs).toContain("@earendil-works/pi-ai");
	});

	test("does NOT match `from` inside a hyphenated string token (is-unsafe SQL catalog)", () => {
		// Minified excerpt from is-unsafe's contexts/sql.js (transitive dep of
		// fast-xml-parser). The `from` in `sql-delete-from` is NOT an import
		// keyword — it is the tail of an id string immediately followed by the
		// string's closing quote. The naive regex captured ",description:" as a
		// bogus specifier and aborted the deploy.
		const code = `{id:"sql-delete-from",description:"DELETE FROM — data deletion injection",pattern:/\\bDELETE\\s{1,20}FROM\\b/i}`;
		const specs = extractBareSpecifiers(code);
		expect(specs).not.toContain(",description:");
		expect(specs).toEqual([]);
	});

	test("does NOT match `from` inside other hyphenated/word tokens", () => {
		const code = `const a="delete-from";const b="transform-data";const c={fromProperty:"x"}`;
		const specs = extractBareSpecifiers(code);
		expect(specs).not.toContain("x");
		expect(specs).toEqual([]);
	});

	test('still resolves minified re-export with no space: }from"spec"', () => {
		// Minifiers drop the space: `export{a}from"spec"`. The `from` keyword is
		// preceded by `}` (not a word/hyphen char), so it MUST still match.
		const code = `export{a}from"real-pkg";import{b}from"other-pkg"`;
		const specs = extractBareSpecifiers(code);
		expect(specs).toContain("real-pkg");
		expect(specs).toContain("other-pkg");
	});
});
