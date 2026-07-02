import { beforeEach, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import manifest from "./manifest.json";
import settings_real from "./settings.json";
import {
	buildArgvFromManifest,
	buildBundleArgvFromLayout,
	detectMode,
	resolveRunDirArgv,
	looksLikeAlias,
	resolveLazyExtension,
	rewriteExtensionArgs,
	type LazySettings,
} from "./resolve.ts";

describe("detectMode", () => {
	test("source mode: url contains /run-dir/", () => {
		expect(
			detectMode("file:///repo/bun-apps/pi-agent/run-dir/resolve.ts"),
		).toBe("source");
	});

	test("binary mode: $bunfs virtual scheme", () => {
		expect(detectMode("file://$bunfs/pi-agent.js")).toBe("binary");
	});

	test("binary mode: ~BUN marker", () => {
		expect(detectMode("file:///~BUN/pi-agent.js")).toBe("binary");
	});

	test("binary mode: URL-encoded ~BUN (%7EBUN)", () => {
		expect(detectMode("file:///%7EBUN/pi-agent.js")).toBe("binary");
	});

	test("binary takes precedence over source", () => {
		// a compiled binary whose path happens to contain /run-dir/ still binary
		expect(detectMode("file://$bunfs/run-dir/x")).toBe("binary");
	});

	test("bundle mode: none of the above (bundled .js next to packages)", () => {
		expect(detectMode("file:///opt/pi-agent/dist/pi-agent.js")).toBe("bundle");
	});

	test("the real module URL (this test run) is source mode", () => {
		// This test file lives in run-dir/ too, so its URL is a source-mode URL.
		expect(detectMode(import.meta.url)).toBe("source");
	});
});

describe("buildArgvFromManifest", () => {
	function setup() {
		const base = mkdtempSync(join(tmpdir(), "pi-rundir-"));
		// materialize the manifest's relative entries under base
		for (const rel of manifest.extensions ?? []) {
			const full = join(base, rel);
			mkdirSync(join(full, ".."), { recursive: true });
			writeFileSync(full, "// ext");
		}
		for (const rel of manifest.skills ?? []) {
			mkdirSync(join(base, rel), { recursive: true });
		}
		return base;
	}

	test("workspace extensions → -e pairs under base, all present", () => {
		const base = setup();
		const warns: string[] = [];
		const argv = buildArgvFromManifest(manifest, base, [], () => true, (m) => warns.push(m));
		// every declared extension appears as `-e <base>/<rel>`
		for (const rel of manifest.extensions ?? []) {
			expect(argv).toContain("-e");
			expect(argv).toContain(join(base, rel));
		}
		expect(warns).toHaveLength(0);
	});

	test("skills → --skill pairs under base", () => {
		const base = setup();
		const argv = buildArgvFromManifest(manifest, base, [], () => true, () => {});
		for (const rel of manifest.skills ?? []) {
			expect(argv).toContain("--skill");
			expect(argv).toContain(join(base, rel));
		}
	});

	test("missing extension path is skipped + warned", () => {
		// exists=false for everything → no -e/--skill emitted, all warned
		const warns: string[] = [];
		const argv = buildArgvFromManifest(
			{ extensions: ["a/x.ts"], skills: ["s"] },
			"/base",
			[],
			() => false,
			(m) => warns.push(m),
		);
		expect(argv).toEqual([]);
		expect(warns.some((w) => w.includes("extension path not found"))).toBe(true);
		expect(warns.some((w) => w.includes("skill path not found"))).toBe(true);
	});

	test("undefined base → workspace ext + skills skipped, npm ext still included, warned once for base", () => {
		const warns: string[] = [];
		const argv = buildArgvFromManifest(
			{ extensions: ["a/x.ts"], skills: ["s"] },
			undefined,
			["/npm/pkg/index.ts"],
			(p) => p.startsWith("/npm"),
			(m) => warns.push(m),
		);
		// only the npm extension survives
		expect(argv).toEqual(["-e", "/npm/pkg/index.ts"]);
		expect(warns.some((w) => w.includes("could not determine bun-apps/"))).toBe(true);
		// workspace ext + skill NOT assembled (no base to join against) → not warned as "not found"
		expect(warns.some((w) => w.includes("extension path not found"))).toBe(false);
		expect(warns.some((w) => w.includes("skill path not found"))).toBe(false);
	});

	test("npm extensions appended AFTER workspace extensions", () => {
		const base = setup();
		const argv = buildArgvFromManifest(
			{ extensions: ["z.ts"] },
			base,
			["/npm/a.ts", "/npm/b.ts"],
			() => true,
			() => {},
		);
		const lastWorkspace = argv.lastIndexOf(join(base, "z.ts"));
		const firstNpm = argv.indexOf("/npm/a.ts");
		expect(lastWorkspace).toBeGreaterThan(-1);
		expect(firstNpm).toBeGreaterThan(lastWorkspace);
	});

	test("empty manifest → empty argv", () => {
		expect(buildArgvFromManifest({}, "/base", [], () => true, () => {})).toEqual([]);
	});

	test("uses the injected exists predicate (not real fs) — a present-on-disk but 'absent' path is skipped", () => {
		const base = setup();
		const argv = buildArgvFromManifest(
			{ extensions: ["z.ts"] },
			base,
			[],
			() => false, // pretend nothing exists
			() => {},
		);
		expect(argv).toEqual([]);
	});
});

describe("resolveRunDirArgv (integration, source mode against the real repo)", () => {
	test("every returned path is absolute and exists on disk", async () => {
		const argv = await resolveRunDirArgv();
		expect(argv.length).toBeGreaterThan(0);
		for (let i = 0; i < argv.length; i++) {
			const tok = argv[i]!;
			if (tok === "-e" || tok === "--skill") {
				const path = argv[i + 1]!;
				expect(path.startsWith("/")).toBe(true); // absolute
				expect(existsSync(path)).toBe(true);
				i++; // consume the path token
			} else if (tok === "-ne") {
				// -ne is a flag with no path payload (deploy-package mode) — not hit here
				continue;
			} else {
				throw new Error(`unexpected token in source-mode argv: ${tok}`);
			}
		}
	});

	test("resolves at least the manifest's workspace extensions + skills", async () => {
		const argv = await resolveRunDirArgv();
		const set = new Set(argv);
		// workspace extensions present in manifest should appear (they exist in this repo)
		expect((manifest.extensions ?? []).length).toBeGreaterThan(0);
		// at least one -e and the skill dir
		expect(argv).toContain("-e");
		expect(argv.filter((t) => t === "-e").length).toBeGreaterThanOrEqual(
			(manifest.extensions ?? []).length,
		);
		// skill dir resolves
		for (const rel of manifest.skills ?? []) {
			expect([...set].some((p) => p.endsWith(rel))).toBe(true);
		}
	});
});

// ─── Lazy / opt-in extension aliases ─────────────────────────────────────────

describe("looksLikeAlias", () => {
	const isAlias = (s: string) => looksLikeAlias(s);
	test("bare names are aliases", () => {
		expect(isAlias("workflow")).toBe(true);
		expect(isAlias("dynamic-workflows")).toBe(true);
		expect(isAlias("flux2")).toBe(true);
	});
	test("paths are NOT aliases", () => {
		expect(isAlias("pi-x/ext.ts")).toBe(false);
		expect(isAlias("./rel.ts")).toBe(false);
		expect(isAlias("/abs/x.ts")).toBe(false);
		expect(isAlias("a/b")).toBe(false);
	});
	test("URL schemes are NOT aliases", () => {
		expect(isAlias("npm:foo")).toBe(false);
		expect(isAlias("git:ssh://x")).toBe(false);
		expect(isAlias("https://x")).toBe(false);
		expect(isAlias("file:///x")).toBe(false);
	});
	test("empty / weird → not alias", () => {
		expect(isAlias("")).toBe(false);
		expect(isAlias(".hidden")).toBe(false);
	});
});

describe("resolveLazyExtension", () => {
	const settings: LazySettings = {
		lazyExtensions: {
			workflow: "pkg-a/extensions/workflow.ts",
			"dynamic-workflows": "pkg-a/extensions/workflow.ts",
			flux2: "pkg-b/extensions/pi-flux2.ts",
		},
	};
	function setup() {
		const base = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		// materialize the registry values
		for (const rel of Object.values(settings.lazyExtensions!)) {
			const full = join(base, rel);
			mkdirSync(join(full, ".."), { recursive: true });
			writeFileSync(full, "// ext");
		}
		// a dir-fallback package (no registry entry): pkg-c/extensions/one.ts
		mkdirSync(join(base, "pkg-c", "extensions"), { recursive: true });
		writeFileSync(join(base, "pkg-c", "extensions", "one.ts"), "// ext");
		// a dir-fallback package with TWO .ts (ambiguous)
		mkdirSync(join(base, "pkg-d", "extensions"), { recursive: true });
		writeFileSync(join(base, "pkg-d", "extensions", "a.ts"), "// ext");
		writeFileSync(join(base, "pkg-d", "extensions", "b.ts"), "// ext");
		return base;
	}

	test("exact key match (case-insensitive)", () => {
		const base = setup();
		const r = resolveLazyExtension("Workflow", settings, base, existsSync);
		expect(r).toBe(join(base, "pkg-a/extensions/workflow.ts"));
		const r2 = resolveLazyExtension("flux2", settings, base, existsSync);
		expect(r2).toBe(join(base, "pkg-b/extensions/pi-flux2.ts"));
	});

	test("unique substring match", () => {
		const base = setup();
		// "workflows" is a substring of "dynamic-workflows" only (and also of
		// "workflow" — so use a substring that hits exactly one key)
		const r = resolveLazyExtension("flux", settings, base, existsSync);
		expect(r).toBe(join(base, "pkg-b/extensions/pi-flux2.ts"));
	});

	test("ambiguous substring → undefined (no guess)", () => {
		const base = setup();
		const warns: string[] = [];
		// "flow" is a substring of both "workflow" and "dynamic-workflows", and
		// is NOT itself a key → ambiguous substring branch
		const r = resolveLazyExtension("flow", settings, base, existsSync, (m) => warns.push(m));
		expect(r).toBeUndefined();
		expect(warns.some((m) => /ambiguous/.test(m))).toBe(true);
	});

	test("non-alias input (path/scheme) → undefined, no fs", () => {
		const base = setup();
		expect(resolveLazyExtension("a/b.ts", settings, base, existsSync)).toBeUndefined();
		expect(resolveLazyExtension("npm:pkg", settings, base, existsSync)).toBeUndefined();
		expect(resolveLazyExtension("/abs/x.ts", settings, base, existsSync)).toBeUndefined();
	});

	test("directory fallback: unique .ts in <alias>/extensions/", () => {
		const base = setup();
		// pkg-c has no registry entry but exactly one extensions/*.ts
		const r = resolveLazyExtension("pkg-c", settings, base, existsSync);
		expect(r).toBe(join(base, "pkg-c", "extensions", "one.ts"));
	});

	test("directory fallback: 0 or ≥2 .ts → undefined", () => {
		const base = setup();
		// pkg-d has two .ts → ambiguous
		expect(resolveLazyExtension("pkg-d", settings, base, existsSync)).toBeUndefined();
		// pkg-e does not exist
		expect(resolveLazyExtension("pkg-e", settings, base, existsSync)).toBeUndefined();
	});

	test("exact match target missing on disk → undefined + warn", () => {
		const base = setup();
		const warns: string[] = [];
		// registry points at a path we never materialized
		const bad: LazySettings = { lazyExtensions: { ghost: "pkg-z/extensions/nope.ts" } };
		const r = resolveLazyExtension("ghost", bad, base, existsSync, (m) => warns.push(m));
		expect(r).toBeUndefined();
		expect(warns.length).toBeGreaterThan(0);
	});

	test("integration: real settings.json + repo resolve 'workflow'", () => {
		// run-dir/resolve.ts sits at <repo>/bun-apps/pi-agent/run-dir/ → base is ../../
		const base = resolve(join(import.meta.dir, "..", ".."));
		const realSettings: LazySettings = settings_real;
		const r = resolveLazyExtension("workflow", realSettings, base, existsSync);
		expect(r).toBeDefined();
		expect(r!.endsWith("pi-dynamic-workflows/extensions/workflow.ts")).toBe(true);
		expect(existsSync(r!)).toBe(true);
	});
});

describe("rewriteExtensionArgs", () => {
	const resolveFn = (v: string) => (v === "workflow" ? "/abs/workflow.ts" : undefined);

	test("rewrites -e and --extension alias values", () => {
		const out = rewriteExtensionArgs(["-e", "workflow"], resolveFn);
		expect(out).toEqual(["-e", "/abs/workflow.ts"]);
		const out2 = rewriteExtensionArgs(["--extension", "workflow"], resolveFn);
		expect(out2).toEqual(["--extension", "/abs/workflow.ts"]);
	});

	test("leaves real paths / unknown aliases untouched", () => {
		const argv = ["-e", "/real/path.ts", "--extension", "unknown-alias", "-p", "hi"];
		expect(rewriteExtensionArgs(argv, resolveFn)).toEqual(argv);
	});

	test("preserves surrounding argv (-p prompt, --model)", () => {
		const argv = ["--model", "x", "-e", "workflow", "-p", "do thing"];
		const out = rewriteExtensionArgs(argv, resolveFn);
		expect(out).toEqual(["--model", "x", "-e", "/abs/workflow.ts", "-p", "do thing"]);
	});

	test("handles multiple -e flags, mixed", () => {
		const argv = ["-e", "workflow", "-e", "/real.ts", "-e", "unknown"];
		const out = rewriteExtensionArgs(argv, resolveFn);
		expect(out).toEqual(["-e", "/abs/workflow.ts", "-e", "/real.ts", "-e", "unknown"]);
	});

	test("no -e flag → unchanged", () => {
		const argv = ["--model", "x", "-p", "hi"];
		expect(rewriteExtensionArgs(argv, resolveFn)).toEqual(argv);
	});
});

describe("buildBundleArgvFromLayout (DEPLOY-BUNDLE mode)", () => {
	const SELF = "/out/pi-agent-bundle";
	const warnFn = (m: string) => warns.push(m);
	let warns: string[] = [];
	beforeEach(() => {
		warns = [];
	});

	test("emits -e per ext-bundle + --skill per skill dir + -e per present npm path", () => {
		const argv = buildBundleArgvFromLayout(
			{
				extBundles: ["obsidian.thin.js", "pi-vlm.thin.js"],
				skillDirs: ["pi-obsidian-skills"],
				npmPaths: ["/repo/node_modules/.bun/x/node_modules/rpiv/index.ts"],
			},
			SELF,
			() => true, // all exist
			warnFn,
		);
		expect(argv).toEqual([
			"-e", join(SELF, "ext-bundles", "obsidian.thin.js"),
			"-e", join(SELF, "ext-bundles", "pi-vlm.thin.js"),
			"-e", "/repo/node_modules/.bun/x/node_modules/rpiv/index.ts",
			"--skill", join(SELF, "skills", "pi-obsidian-skills"),
		]);
		expect(warns).toEqual([]);
	});

	test("filters non-.js entries upstream (caller responsibility) — here just emits what's passed", () => {
		// (deploy.ts filters .js before calling; the builder trusts the list.)
		const argv = buildBundleArgvFromLayout(
			{ extBundles: ["x.thin.js"], skillDirs: [], npmPaths: [] },
			SELF,
			() => true,
			warnFn,
		);
		expect(argv).toEqual(["-e", join(SELF, "ext-bundles", "x.thin.js")]);
	});

	test("missing npm path → skipped + warned (not fatal)", () => {
		const missing = "/repo/node_modules/.bun/x/node_modules/gone/index.ts";
		const argv = buildBundleArgvFromLayout(
			{ extBundles: ["obsidian.thin.js"], skillDirs: [], npmPaths: [missing] },
			SELF,
			(p) => p !== missing, // missing doesn't exist
			warnFn,
		);
		expect(argv).toEqual(["-e", join(SELF, "ext-bundles", "obsidian.thin.js")]);
		expect(warns.join("\n")).toContain("npm extension path not found");
	});

	test("empty layout → empty argv", () => {
		expect(buildBundleArgvFromLayout({ extBundles: [], skillDirs: [], npmPaths: [] }, SELF, () => true, warnFn)).toEqual([]);
	});

	test("portable shape: ext-bundles + empty npmPaths (--portable bundles npm exts in) → no npm -e", () => {
		// .deploy-portable → resolveRunDirArgv passes [] for npmPaths; the pure
		// builder then emits ONLY ext-bundles + skills (npm exts are FULL-bundled).
		const argv = buildBundleArgvFromLayout(
			{ extBundles: ["obsidian.full.js", "juicesharp-rpiv-ask-user-question.full.js"], skillDirs: ["pi-obsidian-skills"], npmPaths: [] },
			SELF,
			() => true,
			warnFn,
		);
		expect(argv).toEqual([
			"-e", join(SELF, "ext-bundles", "obsidian.full.js"),
			"-e", join(SELF, "ext-bundles", "juicesharp-rpiv-ask-user-question.full.js"),
			"--skill", join(SELF, "skills", "pi-obsidian-skills"),
		]);
		expect(warns).toEqual([]);
	});
});
