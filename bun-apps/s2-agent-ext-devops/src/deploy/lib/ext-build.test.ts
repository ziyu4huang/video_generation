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
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyDeployAssets, extractBareSpecifiers, patchOfflinePackageLoader } from "./ext-build.ts";

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

describe("patchOfflinePackageLoader", () => {
	// Verbatim shape of the hyperframes skill helper's bootstrap branch
	// (skills/*/scripts/package-loader.mjs, importPackagesOrBootstrap).
	const LOADER = [
		`const BOOTSTRAP_CONFIRM_ENV = "HYPERFRAMES_SKILL_BOOTSTRAP_DEPS";`,
		`  if (missing.length > 0 && !process.env[BOOTSTRAP_ENV]) {`,
		`    const npmPackages = options.npmPackages ?? missing;`,
		`    assertPinnedPackageSpecs(npmPackages);`,
		`    await confirmBootstrap(npmPackages);`,
		`    bootstrapWithNpmInstall(npmPackages);`,
		`  }`,
	].join("\n");

	test("replaces the npm-install bootstrap with a fail-fast offline throw", () => {
		const patched = patchOfflinePackageLoader(LOADER);
		expect(patched).not.toContain("await confirmBootstrap(npmPackages);");
		expect(patched).not.toContain("bootstrapWithNpmInstall(npmPackages);");
		expect(patched).toContain('throw new Error("package not vendored in the offline s2-agent-sh dist: " + missing.join(", "));');
	});

	test("throws on shape drift — a silent no-op patch is the failure mode gates exist to prevent", () => {
		expect(() => patchOfflinePackageLoader("const x = 1;")).toThrow(/shape drifted/);
	});
});

describe("copyDeployAssets", () => {
	// A minimal npm tree: <root>/node_modules/<pkg>/{package.json,<payload>}.
	// copyDeployAssets resolves the package the same way vendorPackage does
	// (Bun.resolveSync of <pkg>/package.json from the consumer dir), so the
	// fixture mirrors that layout exactly.
	const assetDirs: string[] = [];
	function makeNpmTree(): { root: string; outDir: string } {
		const root = mkdtempSync(join(tmpdir(), "sh-assets-"));
		assetDirs.push(root);
		const outDir = mkdtempSync(join(tmpdir(), "sh-assets-out-"));
		assetDirs.push(outDir);
		return { root, outDir };
	}
	function writePkg(root: string, name: string): string {
		const pkgDir = join(root, "node_modules", name);
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name, version: "0.0.0" }));
		return pkgDir;
	}
	afterAll(() => {
		for (const d of assetDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	test("copies a file payload byte-for-byte under <outDir>/<to>", () => {
		const { root, outDir } = makeNpmTree();
		const pkg = writePkg(root, "tesseract-wasm");
		mkdirSync(join(pkg, "dist"), { recursive: true });
		const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]); // \0asm magic
		writeFileSync(join(pkg, "dist", "tesseract-core.wasm"), wasm);
		const copied = copyDeployAssets(
			[{ pkg: "tesseract-wasm", from: "dist/tesseract-core.wasm", to: "vendored/tesseract-wasm/tesseract-core.wasm" }],
			outDir,
			root,
		);
		expect(copied).toEqual(["vendored/tesseract-wasm/tesseract-core.wasm"]);
		expect(new Uint8Array(readFileSync(join(outDir, "vendored", "tesseract-wasm", "tesseract-core.wasm")))).toEqual(wasm);
	});

	test("copies a directory payload recursively", () => {
		const { root, outDir } = makeNpmTree();
		const pkg = writePkg(root, "pdfjs-dist");
		mkdirSync(join(pkg, "wasm"), { recursive: true });
		writeFileSync(join(pkg, "wasm", "jbig2.wasm"), "jbig2-bytes");
		writeFileSync(join(pkg, "wasm", "openjpeg.wasm"), "openjpeg-bytes");
		copyDeployAssets([{ pkg: "pdfjs-dist", from: "wasm", to: "vendored/pdfjs/wasm" }], outDir, root);
		expect(existsSync(join(outDir, "vendored", "pdfjs", "wasm", "jbig2.wasm"))).toBe(true);
		expect(existsSync(join(outDir, "vendored", "pdfjs", "wasm", "openjpeg.wasm"))).toBe(true);
	});

	test("aborts loudly when the npm payload is missing — never ships a bundle without its assets", () => {
		const { root, outDir } = makeNpmTree();
		writePkg(root, "tesseract-wasm"); // package present, payload absent
		expect(() =>
			copyDeployAssets(
				[{ pkg: "tesseract-wasm", from: "dist/tesseract-core.wasm", to: "vendored/tesseract-wasm/tesseract-core.wasm" }],
				outDir,
				root,
			),
		).toThrow(/asset "tesseract-wasm\/dist\/tesseract-core.wasm" not found.*bun install/s);
	});
});
