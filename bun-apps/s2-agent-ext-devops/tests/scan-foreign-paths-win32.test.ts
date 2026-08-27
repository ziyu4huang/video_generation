/**
 * scanForeignPaths on a WINDOWS build host (crossos t06 review, 2026-08-27).
 *
 * The GH Actions verify channel makes windows-latest a real BUILD host, and a
 * windows bundling defect bakes `C:\Users\…` paths — a leading-`/`-only anchor
 * would silently pass them. These tests pin the drive-letter spellings (both
 * separators) and that windows deploy-tree paths are still allow-listed.
 */
import { describe, expect, test } from "bun:test";
import { scanForeignPaths } from "../src/deploy/lib/ext-build.js";

describe("scanForeignPaths — windows build host (crossos t06)", () => {
	const ROOTS = { home: "C:\\Users\\runneradmin", repo: "C:\\Users\\runneradmin\\proj\\repo" };

	test("flags a baked backslash drive-letter install-cache path (normalized)", () => {
		const code = 'var __dirname="C:\\Users\\runneradmin\\.bun\\install\\cache\\links\\playwright-core@1\\lib";';
		expect(scanForeignPaths(code, "D:\\a\\crossos-verify\\0.7.21", ROOTS)).toEqual([
			"C:/Users/runneradmin/.bun/install/cache/links/playwright-core@1/lib",
		]);
	});

	test("flags the forward-slash drive-letter spelling too", () => {
		const code = 'const p = "C:/Users/runneradmin/proj/repo/bun-apps/x/src/sdk.ts";';
		expect(scanForeignPaths(code, "D:/a/crossos", ROOTS)).toHaveLength(1);
	});

	test("accepts a windows path inside the deploy tree", () => {
		const code = 'var d="D:\\a\\crossos\\ext\\x\\ext.cjs";';
		expect(scanForeignPaths(code, "D:\\a\\crossos", ROOTS)).toEqual([]);
	});

	test("relative paths and URL paths still never match", () => {
		const code = 'const a="./rel"; const b="/v1/chat/completions"; const c="/dev/null";';
		expect(scanForeignPaths(code, "D:/a/crossos", ROOTS)).toEqual([]);
	});
});
