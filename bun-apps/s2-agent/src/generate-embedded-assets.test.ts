/**
 * generate-embedded-assets — manifest content tests.
 *
 * Regression guard for binary-mode /export: pi's generateHtml() reads
 * template.js + vendor/marked.min.js + vendor/highlight.min.js via
 * readFileSync from getExportTemplateDir(), which in --exe mode is the
 * extraction cache populated by THIS manifest. The old blanket .js filter
 * dropped them → ENOENT on export-html/template.js. Runs the real generator
 * against a throwaway piPkgDir/bunAppsDir layout; nothing touches the repo.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateEmbeddedAssets } from "./generate-embedded-assets.ts";

let root: string;
let piPkgDir: string;
let bunAppsDir: string;
let outFilePath: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "gea-"));
	piPkgDir = join(root, "pi-coding-agent");
	bunAppsDir = join(root, "bun-apps");

	// Mirror of the export-html layout pi actually ships.
	const exportHtml = join(piPkgDir, "dist", "core", "export-html");
	const files = [
		"index.js",
		"index.js.map",
		"index.d.ts",
		"ansi-to-html.js",
		"tool-renderer.js",
		"template.js",
		"template.css",
		"template.html",
		"vendor/marked.min.js",
		"vendor/highlight.min.js",
	];
	for (const rel of files) {
		const dst = join(exportHtml, rel);
		mkdirSync(join(dst, ".."), { recursive: true });
		writeFileSync(dst, "/* fixture */\n");
	}
	// A theme file so the second asset root is non-empty too.
	const themeDir = join(piPkgDir, "dist", "modes", "interactive", "theme");
	mkdirSync(themeDir, { recursive: true });
	writeFileSync(join(themeDir, "dark.json"), "{}");

	// The generator writes into <bunAppsDir>/s2-agent/src/generated/.
	outFilePath = join(bunAppsDir, "s2-agent", "src", "generated", "embedded-assets.ts");
	mkdirSync(join(outFilePath, ".."), { recursive: true });
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function generate(embedMode: boolean): string {
	generateEmbeddedAssets(piPkgDir, bunAppsDir, [], embedMode);
	return readFileSync(outFilePath, "utf8");
}

describe("generateEmbeddedAssets — code-ext filter", () => {
	test("embeds runtime-read client scripts (template.js, vendor/*.min.js)", () => {
		const out = generate(true);
		expect(out).toContain('"export-html/template.js"');
		expect(out).toContain('"export-html/vendor/marked.min.js"');
		expect(out).toContain('"export-html/vendor/highlight.min.js"');
	});

	test("still excludes ES-module .js files pi bundles into the binary", () => {
		const out = generate(true);
		expect(out).not.toContain('"export-html/index.js"');
		expect(out).not.toContain('"export-html/ansi-to-html.js"');
		expect(out).not.toContain('"export-html/tool-renderer.js"');
		// .js.map / .d.ts have non-code extensions — never filtered, by design.
	});

	test("embeds non-code assets and theme files", () => {
		const out = generate(true);
		expect(out).toContain('"export-html/template.html"');
		expect(out).toContain('"export-html/template.css"');
		expect(out).toContain('"theme/dark.json"');
	});

	test("embedMode=false writes an empty manifest with no imports", () => {
		const out = generate(false);
		expect(out).toContain("EMBEDDED_ASSETS: Array<{ relPath: string; blobPath: string }> = []");
		expect(out).not.toContain('with { type: "file" }');
	});

	test("missing source dirs are skipped without error", () => {
		// bunAppsDir fixture has no binarySkills dirs; assets/ absent in piPkgDir.
		const out = generate(true);
		expect(out).not.toContain('"assets/');
		expect(existsSync(outFilePath)).toBe(true);
	});
});
