import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractBareSpecifiers, stageVendoredAssets } from "./build-extensions.ts";

// extractBareSpecifiers scans minified bundle output for ESM import / re-export
// bare specifiers (the things that must be abs-resolved or marked external).
// It MUST NOT match a `from` that is merely a substring of a larger token —
// e.g. the `from` inside the string `"sql-delete-from"`, which a naive
// `/from\s*["']/` regex misreads as `from "…,description:"` and then fails to
// resolve (breaking the whole deploy — the deploy-verify regression introduced
// when research-tool pulled in fast-xml-parser → is-unsafe's SQL-injection
// catalog, whose entries look like {id:"sql-delete-from",description:"…"}).
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
		// node:fs is a builtin, not a bare specifier the resolver handles, but it
		// is still *extracted* here — resolution is the caller's job. We only
		// assert the real specifiers survived.
	});

	test("does NOT match `from` inside a hyphenated string token (is-unsafe SQL catalog)", () => {
		// Minified excerpt from is-unsafe's contexts/sql.js (transitive dep of
		// fast-xml-parser). The `from` in `sql-delete-from` is NOT an import
		// keyword — it is the tail of an id string immediately followed by the
		// string's closing quote. The naive regex captured ",description:" as a
		// bogus specifier.
		const code = `{id:"sql-delete-from",description:"DELETE FROM — data deletion injection",pattern:/\\bDELETE\\s{1,20}FROM\\b/i}`;
		const specs = extractBareSpecifiers(code);
		expect(specs).not.toContain(",description:");
		expect(specs).toEqual([]);
	});

	test("does NOT match `from` inside other hyphenated/word tokens", () => {
		const code = `const a="delete-from";const b="transform-data";const c={fromProperty:"x"}`;
		const specs = extractBareSpecifiers(code);
		// `fromProperty:"x"` has a `:` before the quote, so even un-anchored it
		// would not match; the hyphenated `delete-from"` is the real trap.
		expect(specs).not.toContain("x");
		expect(specs).toEqual([]);
	});

	test("still resolves minified re-export with no space: }from\"spec\"", () => {
		// Minifiers drop the space: `export{a}from"spec"`. The `from` keyword is
		// preceded by `}` (not a word/hyphen char), so it MUST still match.
		const code = `export{a}from"real-pkg";import{b}from"other-pkg"`;
		const specs = extractBareSpecifiers(code);
		expect(specs).toContain("real-pkg");
		expect(specs).toContain("other-pkg");
	});
});

describe("stageVendoredAssets", () => {
	test("copies a package's vendored/ tree into targetDir/vendored/", () => {
		const pkgDir = mkdtempSync(join(tmpdir(), "pkg-"));
		const targetDir = mkdtempSync(join(tmpdir(), "tgt-"));
		mkdirSync(join(pkgDir, "vendored", "bin"), { recursive: true });
		writeFileSync(join(pkgDir, "vendored", "bin", "archify.mjs"), "// stub");
		try {
			stageVendoredAssets([{ name: "pi-agent-ext-archify", pkgDir }], targetDir);
			expect(existsSync(join(targetDir, "vendored", "bin", "archify.mjs"))).toBe(true);
		} finally {
			rmSync(pkgDir, { recursive: true, force: true });
			rmSync(targetDir, { recursive: true, force: true });
		}
	});

	test("is a no-op when the package has no vendored/ tree", () => {
		const pkgDir = mkdtempSync(join(tmpdir(), "pkg-novendor-"));
		const targetDir = mkdtempSync(join(tmpdir(), "tgt-novendor-"));
		try {
			stageVendoredAssets([{ name: "no-vendored", pkgDir }], targetDir);
			expect(existsSync(join(targetDir, "vendored"))).toBe(false);
		} finally {
			rmSync(pkgDir, { recursive: true, force: true });
			rmSync(targetDir, { recursive: true, force: true });
		}
	});
});
