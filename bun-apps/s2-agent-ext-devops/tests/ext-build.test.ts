import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildExtPackage,
	loadProbe,
	matchesAllowed,
	rewriteAllowedDynamicImports,
	rewriteVendoredDynamicImports,
	scanForeignPaths,
	scanForeignSpecifiers,
	scanUnroutableDynamicImports,
	vendorPackage,
} from "../src/deploy/lib/ext-build.ts";

const BUN_APPS = join(import.meta.dir, "..", "..");
const HOST_MODULES = [
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
	"typebox/value",
	"@repo/s2-agent-core-runtime",
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

describe("matchesAllowed", () => {
	test("matches an exact entry", () => {
		expect(matchesAllowed("typebox", ["typebox"])).toBe(true);
		expect(matchesAllowed("typebox/value", ["typebox"])).toBe(false);
	});

	test("a /* entry matches any subpath of that package", () => {
		expect(matchesAllowed("chromium-bidi/lib/cjs/bidiMapper/BidiMapper", ["chromium-bidi/*"])).toBe(true);
		expect(matchesAllowed("chromium-bidi", ["chromium-bidi/*"])).toBe(false);
		expect(matchesAllowed("chromium-bidi-evil/x", ["chromium-bidi/*"])).toBe(false);
	});
});

describe("scanForeignSpecifiers", () => {
	test("accepts a bundle that only requires host modules", () => {
		const code = `var a = require("typebox");\nimport x from "@earendil-works/pi-tui";`;
		expect(scanForeignSpecifiers(code, HOST_MODULES)).toEqual([]);
	});

	test("accepts a deep subpath covered by a /* external", () => {
		const code = `var b = require("chromium-bidi/lib/cjs/bidiMapper/BidiMapper");`;
		expect(scanForeignSpecifiers(code, [...HOST_MODULES, "chromium-bidi/*"])).toEqual([]);
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
	test("builds power-tool into ext.cjs + ext.json", async () => {
		const out = makeDir();
		const res = await buildExtPackage({
			ext: {
				name: "power-tool",
				package: "s2-agent-ext-power-tool",
				entry: "extensions/power-tool.ts",
				order: 50,
				skills: [],
				copy: [],
				enabled: true,
				externals: ["chromium-bidi/*", "kerberos", "vite", "@playwright/test"],
				vendorExclude: [],
				vendor: ["playwright-core"],
			},
			bunAppsDir: BUN_APPS,
			outDir: join(out, "power-tool"),
			deployRoot: out,
			hostApi: 1,
			hostModules: HOST_MODULES,
			sourceSha: "deadbee",
			builtAt: "2026-08-19T00:00:00Z",
		});

		expect(existsSync(join(out, "power-tool", "ext.cjs"))).toBe(true);
		expect(existsSync(join(out, "power-tool", "skills"))).toBe(false);
		const manifest = JSON.parse(readFileSync(join(out, "power-tool", "ext.json"), "utf8"));
		expect(manifest.name).toBe("power-tool");
		expect(manifest.hostApi).toBe(1);
		expect(manifest.entry).toBe("ext.cjs");
		expect(manifest.order).toBe(50);
		expect(manifest.skills).toEqual([]);
		// only host modules may remain unresolved
		expect(manifest.hostModules.every((m: string) => HOST_MODULES.includes(m))).toBe(true);
		// A declared runtime external is recorded but NOT claimed as host-provided:
		// the core does not supply playwright-core, it merely is not bundled.
		expect(manifest.runtimeExternals).toEqual(["chromium-bidi/*", "kerberos", "vite", "@playwright/test"]);
		expect(manifest.hostModules).not.toContain("chromium-bidi/*");
		// playwright-core is VENDORED, not bundled: it ships as a real directory
		// so its `__dirname` points inside the deploy. Three consequences, all
		// asserted, because each was a defect at some point:
		expect(manifest.vendored).toEqual(["playwright-core"]);
		expect(existsSync(join(out, "power-tool", "node_modules", "playwright-core", "package.json"))).toBe(true);
		// the bundle is kilobytes now, not the ~3.8 MB it was when inlined
		expect(res.bytes).toBeLessThan(1_000_000);
		expect(res.bytes).toBeGreaterThan(0);
		// and its dynamic import goes through require, or it would resolve
		// against the compiled binary's virtual root at runtime
		const built = readFileSync(join(out, "power-tool", "ext.cjs"), "utf8");
		expect(built).toContain('Promise.resolve(require("playwright-core"))');
		expect(built).not.toContain('import("playwright-core")');
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
					copy: [],
					enabled: true,
					externals: [],
					vendorExclude: [],
					vendor: [],
				},
				bunAppsDir: out,
				outDir: join(out, "built"),
				deployRoot: out,
				hostApi: 1,
				hostModules: HOST_MODULES,
				sourceSha: "deadbee",
				builtAt: "2026-08-19T00:00:00Z",
			}),
		).rejects.toThrow(/definitely-not-installed-pkg/);
	}, 120_000);

	// THE REGRESSION THIS LOCKS OUT (2026-08-22, post-#1806 regression scan):
	// sv-analyzer's registry entry declares `copy: [wasm]` — a GITIGNORED,
	// regenerated artifact mirrored by dsh-plugin/sv-analyzer/build.sh. The copy
	// loop previously did a bare cpSync, so a deploy from any worktree that had
	// not run build.sh (fresh clone, synced main) crashed with a raw
	// "ENOENT: stat .../wasm" stack — and the Deploy-sh L1 e2e gate (which runs
	// a real deploy in EVERY local CI, regardless of change scope) went red on
	// it. A deploy must still FAIL on a missing declared copy dir (silently
	// shipping a bundle without it ships a broken extension), but the error must
	// name the artifact and the fix.
	test("fails with an actionable message when a declared copy dir is missing", async () => {
		const out = makeDir();
		const pkgDir = join(out, "fake-ext");
		mkdirSync(join(pkgDir, "extensions"), { recursive: true });
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({ name: "fake-ext", version: "0.0.0", type: "module" }),
		);
		writeFileSync(
			join(pkgDir, "extensions", "fake.ts"),
			`export default () => {};`,
		);
		await expect(
			buildExtPackage({
				ext: {
					name: "fake-ext",
					package: "fake-ext",
					entry: "extensions/fake.ts",
					order: 1,
					skills: [],
					copy: ["wasm"],
					enabled: true,
					externals: [],
					vendorExclude: [],
					vendor: [],
				},
				bunAppsDir: out,
				outDir: join(out, "built"),
				deployRoot: out,
				hostApi: 1,
				hostModules: HOST_MODULES,
				sourceSha: "deadbee",
				builtAt: "2026-08-19T00:00:00Z",
			}),
		).rejects.toThrow(/copy dir 'wasm' not found.*build\.sh/);
	}, 120_000);

	// THE DEFECT THIS LOCKS OUT (2026-08-20, /websearch): web-access's
	// resolveOpenAIAuth did `await import("@earendil-works/pi-ai/compat")` — a
	// HOST module. Bun's --format=cjs turns static imports into require calls
	// inside the wrapper (routed through the loader's injected require), but a
	// dynamic import() stays native; inside a compiled binary native resolution
	// is virtualized onto $bunfs and cannot see host modules or the real fs, so
	// /websearch died with "Cannot find module '@earendil-works/pi-ai/compat'
	// from '/$bunfs/root/s2-agent'". Gate 1 was blind to it (the specifier IS
	// allowed — it just isn't REACHABLE as a dynamic import), and the load probe
	// only executes top-level code. The fix rewrites every allowed dynamic
	// import to require at build time; this test proves it on the real bundler.
	test("rewrites an allowed (host) dynamic import through require — the /websearch defect", async () => {
		const out = makeDir();
		const pkgDir = join(out, "dynimp-ext");
		mkdirSync(join(pkgDir, "extensions"), { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "dynimp-ext", version: "0.0.0", type: "module" }));
		writeFileSync(
			join(pkgDir, "extensions", "dyn.ts"),
			// A host module dynamic import — exactly the openai-search.ts shape.
			`export default () => ({ probe: async () => await import("@earendil-works/pi-tui") });\n`,
		);
		await buildExtPackage({
			ext: {
				name: "dynimp-ext",
				package: "dynimp-ext",
				entry: "extensions/dyn.ts",
				order: 1,
				skills: [],
				copy: [],
				enabled: true,
				externals: [],
				vendorExclude: [],
				vendor: [],
			},
			bunAppsDir: out,
			outDir: join(out, "built"),
			deployRoot: out,
			hostApi: 1,
			hostModules: HOST_MODULES,
			sourceSha: "deadbee",
			builtAt: "2026-08-20T00:00:00Z",
		});
		const built = readFileSync(join(out, "built", "ext.cjs"), "utf8");
		expect(built).toContain('Promise.resolve(require("@earendil-works/pi-tui"))');
		expect(built).not.toMatch(/import\(\s*["@']@earendil-works\/pi-tui["@']/);
	}, 120_000);

	// Vendoring used to copy ONE package verbatim, which silently half-ships any
	// root with a dependency tree (hyperframes' producer → puppeteer, fonts, …).
	// The deploy must ship the closure or the skill dangles at runtime with no
	// offline remediation. Optional deps that are simply not installed are
	// pruned, never copied, never an error.
	test("vendors the dependency CLOSURE of a vendor: root, recording pruned optionals", async () => {
		const out = makeDir();
		const pkgDir = join(out, "closure-ext");
		mkdirSync(join(pkgDir, "extensions"), { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "closure-ext", version: "0.0.0", type: "module" }));
		writeFileSync(join(pkgDir, "extensions", "closure.ts"), `export default () => ({});\n`);
		const writePkg = (name: string, pkgJson: Record<string, unknown>) => {
			const dir = join(pkgDir, "node_modules", name);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "package.json"), JSON.stringify(pkgJson));
		};
		writePkg("vendored-root", {
			name: "vendored-root",
			version: "1.0.0",
			dependencies: { "dep-a": "*" },
			optionalDependencies: { "not-installed-opt": "*" },
		});
		writePkg("dep-a", { name: "dep-a", version: "1.0.0", dependencies: { "dep-b": "*" } });
		writePkg("dep-b", { name: "dep-b", version: "1.0.0" });

		await buildExtPackage({
			ext: {
				name: "closure-ext",
				package: "closure-ext",
				entry: "extensions/closure.ts",
				order: 1,
				skills: [],
				copy: [],
				enabled: true,
 				externals: [],
				vendorExclude: [],
				vendor: ["vendored-root"],
			},
			bunAppsDir: out,
			outDir: join(out, "built"),
			deployRoot: out,
			hostApi: 1,
			hostModules: HOST_MODULES,
			sourceSha: "deadbee",
			builtAt: "2026-08-21T00:00:00Z",
		});

		for (const name of ["vendored-root", "dep-a", "dep-b"]) {
			expect(existsSync(join(out, "built", "node_modules", name, "package.json"))).toBe(true);
		}
		const manifest = JSON.parse(readFileSync(join(out, "built", "ext.json"), "utf8"));
		expect(manifest.vendored).toEqual(["vendored-root"]);
		expect(manifest.vendoredClosure.count).toBe(3);
		expect(manifest.vendoredClosure.pruned).toContain("not-installed-opt");
	}, 120_000);
});

// ── Gate 4 ──────────────────────────────────────────────────────────────────
describe("scanForeignPaths", () => {
	const ROOTS = { home: "/Users/builder", repo: "/Users/builder/proj/repo" };

	test("flags the builder's install cache — the playwright __dirname defect", () => {
		const code = `var __dirname="/Users/builder/.bun/install/cache/links/playwright-core@1/node_modules/playwright-core/lib";`;
		expect(scanForeignPaths(code, "/deploy/0.1.0", ROOTS)).toEqual([
			"/Users/builder/.bun/install/cache/links/playwright-core@1/node_modules/playwright-core/lib",
		]);
	});

	test("flags a source path from the build repo", () => {
		const code = `const p = "/Users/builder/proj/repo/bun-apps/s2-agent-ext-power-tool/src/sdk-patch.ts";`;
		expect(scanForeignPaths(code, "/deploy/0.1.0", ROOTS)).toHaveLength(1);
	});

	test("flags the file:// form — createRequire's baked build-machine base", () => {
		// The pre-a9ecc1aec sdk-patch shipped exactly this; the quote-then-slash
		// anchor alone misses it because the string starts with 'f'.
		const code = `var r=x.createRequire("file:///Users/builder/proj/repo/bun-apps/s2-agent-ext-power-tool/src/sdk-patch.ts");`;
		expect(scanForeignPaths(code, "/deploy/0.1.0", ROOTS)).toEqual([
			"/Users/builder/proj/repo/bun-apps/s2-agent-ext-power-tool/src/sdk-patch.ts",
		]);
	});

	test("accepts a file:// URL outside home and repo", () => {
		const code = `const u = "file:///deploy/0.1.0/ext/power-tool/ext.cjs";`;
		expect(scanForeignPaths(code, "/deploy/0.1.0", ROOTS)).toEqual([]);
	});

	test("accepts paths inside the deploy tree", () => {
		const code = `var d="/deploy/0.1.0/ext/power-tool/node_modules/playwright-core/lib";`;
		expect(scanForeignPaths(code, "/deploy/0.1.0", ROOTS)).toEqual([]);
	});

	test("accepts $HOME/.pi — the agent's own per-user state dir", () => {
		const code = `const s = "/Users/builder/.pi/agent/sessions";`;
		expect(scanForeignPaths(code, "/deploy/0.1.0", ROOTS)).toEqual([]);
	});

	test("does not fire on URL paths or system paths (the false-positive trap)", () => {
		const code = `fetch("/v1/chat/completions"); open("/dev/null"); spawn("/usr/bin/env");`;
		expect(scanForeignPaths(code, "/deploy/0.1.0", ROOTS)).toEqual([]);
	});
});

describe("rewriteAllowedDynamicImports", () => {
	test("routes a HOST-module dynamic import through require — the /websearch defect shape", () => {
		const code = `const { getModel } = await import("@earendil-works/pi-ai/compat");`;
		expect(
			rewriteAllowedDynamicImports(code, [...HOST_MODULES, "@earendil-works/pi-ai/compat"]),
		).toBe(`const { getModel } = await Promise.resolve(require("@earendil-works/pi-ai/compat"));`);
	});

	test("covers subpaths via the /* wildcard form", () => {
		const code = `await import("chromium-bidi/lib/cjs/bidiMapper/BidiMapper");`;
		expect(rewriteAllowedDynamicImports(code, ["chromium-bidi/*"])).toBe(
			`await Promise.resolve(require("chromium-bidi/lib/cjs/bidiMapper/BidiMapper"));`,
		);
	});

	test("leaves node builtins native (they resolve fine in a compiled binary)", () => {
		const code = `await import("node:sqlite"); await import("os");`;
		expect(rewriteAllowedDynamicImports(code, HOST_MODULES)).toBe(code);
	});

	test("leaves a non-allowed dynamic import for Gate 1 to reject", () => {
		const code = `await import("left-pad");`;
		expect(rewriteAllowedDynamicImports(code, HOST_MODULES)).toBe(code);
	});
});

describe("scanUnroutableDynamicImports", () => {
	test("flags a bare dynamic import that survived the rewrite — the /websearch defect", () => {
		const code = `const { getModel } = await import("@earendil-works/pi-ai/compat");`;
		expect(scanUnroutableDynamicImports(code)).toEqual(["@earendil-works/pi-ai/compat"]);
	});

	test("accepts builtins, relative/absolute paths, and the # channel", () => {
		const code = `await import("node:sqlite"); await import("./x.js"); await import("/abs/x.js"); await import("#pi/ext-dir");`;
		expect(scanUnroutableDynamicImports(code)).toEqual([]);
	});
});

describe("rewriteVendoredDynamicImports", () => {
	test("routes a vendored dynamic import through require", () => {
		const code = `let{chromium:q}=await import("playwright-core");`;
		expect(rewriteVendoredDynamicImports(code, ["playwright-core"])).toBe(
			`let{chromium:q}=await Promise.resolve(require("playwright-core"));`,
		);
	});

	test("handles every quote style and stray whitespace", () => {
		const code = `import('playwright-core') + import( \`playwright-core\` )`;
		const out = rewriteVendoredDynamicImports(code, ["playwright-core"]);
		expect(out).not.toContain("import(");
		expect(out.match(/require\("playwright-core"\)/g)).toHaveLength(2);
	});

	test("leaves a non-vendored dynamic import alone", () => {
		const code = `await import("something-else");`;
		expect(rewriteVendoredDynamicImports(code, ["playwright-core"])).toBe(code);
	});
});

describe("vendorPackage", () => {
	test("copies the resolved package into <outDir>/node_modules/<pkg>", () => {
		const out = makeDir();
		const dest = vendorPackage("playwright-core", out, join(BUN_APPS, "s2-agent-ext-power-tool"));
		expect(dest).toBe(join(out, "node_modules", "playwright-core"));
		expect(existsSync(join(dest, "package.json"))).toBe(true);
		// dereferenced: a symlink here would point back at the build machine's
		// store, which is the failure vendoring exists to avoid
		expect(lstatSync(dest).isSymbolicLink()).toBe(false);
	}, 60_000);
});
