import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExtPackage, loadProbe, scanForeignSpecifiers } from "../scripts/lib/sh-ext-build.ts";

const BUN_APPS = join(import.meta.dir, "..", "..");
const HOST_MODULES = [
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
	"typebox/value",
	"@repo/pi-agent-core-runtime",
];

const dirs: string[] = [];
function makeDir(): string {
	const d = mkdtempSync(join(tmpdir(), "sh-extbuild-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("scanForeignSpecifiers", () => {
	test("accepts a bundle that only requires host modules", () => {
		const code = `var a = require("typebox");\nimport x from "@earendil-works/pi-tui";`;
		expect(scanForeignSpecifiers(code, HOST_MODULES)).toEqual([]);
	});

	test("reports a specifier the host does not provide", () => {
		const code = `import x from "left-pad";`;
		expect(scanForeignSpecifiers(code, HOST_MODULES)).toEqual(["left-pad"]);
	});

	test("ignores node builtins and relative paths", () => {
		const code = `import a from "node:fs";\nimport b from "./local.js";\nimport c from "path";`;
		expect(scanForeignSpecifiers(code, HOST_MODULES)).toEqual([]);
	});
});

describe("loadProbe", () => {
	test("accepts a cjs bundle with a callable default export", () => {
		const dir = makeDir();
		const f = join(dir, "ext.cjs");
		writeFileSync(
			f,
			`// @bun @bun-cjs\n(function(exports, require, module, __filename, __dirname) {\nmodule.exports.default = () => ({});\n})\n`,
		);
		expect(() => loadProbe(f, HOST_MODULES)).not.toThrow();
	});

	test("rejects a bundle with no default export", () => {
		const dir = makeDir();
		const f = join(dir, "ext.cjs");
		writeFileSync(
			f,
			`// @bun @bun-cjs\n(function(exports, require, module, __filename, __dirname) {\nmodule.exports.other = 1;\n})\n`,
		);
		expect(() => loadProbe(f, HOST_MODULES)).toThrow(/default export/);
	});

	test("rejects output that is not a cjs wrapper", () => {
		const dir = makeDir();
		const f = join(dir, "ext.cjs");
		writeFileSync(f, `var notAWrapper = 1;`);
		expect(() => loadProbe(f, HOST_MODULES)).toThrow(/cjs wrapper/);
	});
});

describe("buildExtPackage", () => {
	test("builds power-tool into ext.cjs + ext.json + skills", async () => {
		const out = makeDir();
		const res = await buildExtPackage({
			ext: {
				name: "power-tool",
				package: "pi-agent-ext-power-tool",
				entry: "extensions/power-tool.ts",
				order: 50,
				skills: ["skills"],
				enabled: true,
				externals: ["playwright-core"],
			},
			bunAppsDir: BUN_APPS,
			outDir: join(out, "power-tool"),
			hostApi: 1,
			hostModules: HOST_MODULES,
			sourceSha: "deadbee",
			builtAt: "2026-08-19T00:00:00Z",
		});

		expect(existsSync(join(out, "power-tool", "ext.cjs"))).toBe(true);
		expect(existsSync(join(out, "power-tool", "skills"))).toBe(true);
		const manifest = JSON.parse(readFileSync(join(out, "power-tool", "ext.json"), "utf8"));
		expect(manifest.name).toBe("power-tool");
		expect(manifest.hostApi).toBe(1);
		expect(manifest.entry).toBe("ext.cjs");
		expect(manifest.order).toBe(50);
		expect(manifest.skills).toEqual(["skills"]);
		// only host modules may remain unresolved
		expect(manifest.hostModules.every((m: string) => HOST_MODULES.includes(m))).toBe(true);
		// A declared runtime external is recorded but NOT claimed as host-provided:
		// the core does not supply playwright-core, it merely is not bundled.
		expect(manifest.runtimeExternals).toEqual(["playwright-core"]);
		expect(manifest.hostModules).not.toContain("playwright-core");
		expect(res.bytes).toBeGreaterThan(0);
	}, 120_000);

	test("fails the build when the bundle references a non-host bare specifier", async () => {
		const out = makeDir();
		const pkgDir = join(out, "fake-ext");
		mkdirSync(join(pkgDir, "extensions"), { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "fake-ext", version: "0.0.0", type: "module" }));
		writeFileSync(
			join(pkgDir, "extensions", "fake.ts"),
			`import x from "definitely-not-installed-pkg";\nexport default () => ({ x });\n`,
		);
		await expect(
			buildExtPackage({
				ext: {
					name: "fake-ext",
					package: "fake-ext",
					entry: "extensions/fake.ts",
					order: 1,
					skills: [],
					enabled: true,
					externals: [],
				},
				bunAppsDir: out,
				outDir: join(out, "built"),
				hostApi: 1,
				hostModules: HOST_MODULES,
				sourceSha: "deadbee",
				builtAt: "2026-08-19T00:00:00Z",
			}),
		).rejects.toThrow(/definitely-not-installed-pkg/);
	}, 120_000);
});
