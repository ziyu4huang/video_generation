import { beforeEach, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import manifest from "./manifest.json";
import {
	buildArgvFromManifest,
	resolveRunDirArgv,
	looksLikeAlias,
	resolveLazyExtension,
	rewriteExtensionArgs,
	suppressResolvedArgv,
	runtimeDependencyNames,
	type LazySettings,
} from "./resolve.ts";

// detectMode's own suite lives at src/mode.test.ts (the canonical seam test —
// .ts→source, .js→bundle, own-URL→source). This file keeps only the
// argv/manifest resolution behavior that is its real subject.
// (dedup 2026-08-25, round-2 ticket 03)

describe("buildArgvFromManifest", () => {
	function setup() {
		const base = mkdtempSync(join(tmpdir(), "pi-rundir-"));
		// Normalize manifest v2 entries: objects → their `entry` string.
		const extEntries = (manifest.extensions ?? []).map((e) => (typeof e === "string" ? e : (e as { entry: string }).entry));
		// materialize the manifest's relative entries under base
		for (const rel of extEntries) {
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
		const extEntries = (manifest.extensions ?? []).map((e) => (typeof e === "string" ? e : (e as { entry: string }).entry));
		for (const rel of extEntries) {
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

	test("malformed entry (object missing 'entry') is skipped + warned, not a crash (I-1)", () => {
		// A declared object without `entry` previously made path.join throw an
		// opaque "paths[1] must be a string" TypeError at boot. Manifest entries
		// arrive as raw JSON (not typed literals), so simulate that reality and
		// assert the guard skips + warns instead of crashing.
		const malformed = JSON.parse('{"name":"phantom"}'); // raw object, no `entry`
		const warns: string[] = [];
		const argv = buildArgvFromManifest(
			{ extensions: [malformed, "real/x.ts"] },
			"/base",
			[],
			() => true,
			(m) => warns.push(m),
		);
		expect(argv).toEqual(["-e", join("/base", "real/x.ts")]);
		expect(warns.some((w) => w.includes("missing 'entry'") && w.includes("phantom"))).toBe(true);
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

	test("user -ne/-ns suppress the injected -e/--skill pairs", async () => {
		const suppressed = await resolveRunDirArgv({ noExtensions: true, noSkills: true });
		expect(suppressed).not.toContain("-e");
		expect(suppressed).not.toContain("--skill");

		// -ne alone keeps skills flowing
		const extOnly = await resolveRunDirArgv({ noExtensions: true });
		expect(extOnly).not.toContain("-e");
		expect(extOnly).toContain("--skill");

		// default (no flags) is unchanged
		const full = await resolveRunDirArgv();
		expect(full).toContain("-e");
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
			workflow: "pkg-a/extensions/ultracode.ts",
			"dynamic-workflows": "pkg-a/extensions/ultracode.ts",
			flux2: "pkg-b/extensions/flux2.ts",
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

	test("non-empty alias registry → warn + fall through (resolver retired)", () => {
		const base = setup();
		const warns: string[] = [];
		// Exact/substring arms were removed with the retired resolver; a
		// non-empty map must WARN (not silently strand) and defer to the
		// directory fallback / SDK.
		const r = resolveLazyExtension("Workflow", settings, base, existsSync, (m) => warns.push(m));
		expect(r).toBeUndefined();
		expect(warns.some((m) => /retired/.test(m))).toBe(true);
	});

	test("empty alias registry → no warn, directory fallback still applies", () => {
		const base = setup();
		const warns: string[] = [];
		const r = resolveLazyExtension("pkg-c", { lazyExtensions: {} }, base, existsSync, (m) => warns.push(m));
		expect(r).toBe(join(base, "pkg-c", "extensions", "one.ts"));
		expect(warns).toHaveLength(0);
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

	// workflow was migrated from a lazy alias to a STATIC extension
	// (src/static-extensions.ts) so the single-exe build bundles it. A lazy
	// alias for a static extension would double-register it (jiti-loaded module
	// ≠ natively-imported module identity; pi dedups `-e`×`-e` by path, NOT
	// static-factory×`-e`). This test now guards that invariant: `workflow`
	// must NOT resolve via the lazy mechanism against the real manifest.
	test("integration: real manifest.json has NO lazy alias for the static 'workflow' ext", () => {
		// src/run-dir/resolve.ts sits at <repo>/bun-apps/s2-agent/src/run-dir/ → base is ../../..
		const base = resolve(join(import.meta.dir, "..", "..", ".."));
		// lazyExtensions is {} now; the directory-fallback arm looks for
		// <base>/workflow/extensions/ which doesn't exist (the package dir is
		// s2-agent-ext-ultracode, not workflow) → undefined either way.
		const r = resolveLazyExtension("workflow", manifest, base, existsSync);
		expect(r).toBeUndefined();
		// And the real manifest's lazyExtensions is empty (no aliases left).
		expect(Object.keys(manifest.lazyExtensions ?? {})).toEqual([]);
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

describe("resolveLazyExtension — ENOTDIR hardening", () => {
	const settings: LazySettings = {
		lazyExtensions: { workflow: "pkg-a/extensions/ultracode.ts" },
	};

	test("does not crash when <alias>/extensions exists as a FILE (not a dir)", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-lazy-enotdir-"));
		// Materialize the registry entry so exact-match works for "workflow".
		mkdirSync(join(base, "pkg-a", "extensions"), { recursive: true });
		writeFileSync(join(base, "pkg-a", "extensions", "workflow.ts"), "// ext");
		// Make <base>/pkg-file/extensions a FILE (not a dir). existsSync=true,
		// readdirSync → ENOTDIR. Resolving alias "pkg-file" must not throw.
		mkdirSync(join(base, "pkg-file"), { recursive: true });
		writeFileSync(join(base, "pkg-file", "extensions"), "i am a file not a dir");

		// "pkg-file" is not in the registry → reaches the directory fallback,
		// which calls readdirSync on the file path. Must return undefined, not throw.
		expect(() => resolveLazyExtension("pkg-file", settings, base, existsSync)).not.toThrow();
		expect(resolveLazyExtension("pkg-file", settings, base, existsSync)).toBeUndefined();
	});
});

// ─── resolveLazyExtension with undefined base (audit finding #4) ──────────────

describe("resolveLazyExtension — undefined bunAppsDir", () => {
	const settings: LazySettings = {
		lazyExtensions: { workflow: "pkg-a/extensions/ultracode.ts" },
	};

	test("skips the directory fallback when bunAppsDir is undefined (no crash, no fs)", () => {
		// "pkg-c" is not in the registry → would otherwise hit the dir fallback.
		// With bunAppsDir undefined the `if (bunAppsDir)` branch is skipped, so
		// there is no readdirSync on a path derived from an undefined base.
		expect(() => resolveLazyExtension("pkg-c", settings, undefined, () => true)).not.toThrow();
		expect(resolveLazyExtension("pkg-c", settings, undefined, () => true)).toBeUndefined();
	});

	test("non-alias input with undefined base → undefined (guarded before any base use)", () => {
		expect(resolveLazyExtension("a/b.ts", settings, undefined, () => true)).toBeUndefined();
		expect(resolveLazyExtension("npm:pkg", settings, undefined, () => true)).toBeUndefined();
	});
});

// ─── rewriteExtensionArgs identity no-op (audit finding #5) ───────────────────

describe("rewriteExtensionArgs — identity replacement", () => {
	test("resolve returning the same value → no rewrite, no warning", () => {
		// If a resolver returns the input unchanged (e.g. an already-absolute
		// path that happens to pass through), `resolved !== val` is false and the
		// arg is left in place — no spurious warning, argv byte-identical.
		const identity = (v: string) => v;
		const argv = ["-e", "/already/abs.ts", "-p", "hi"];
		const warns: string[] = [];
		expect(rewriteExtensionArgs(argv, identity, (m) => warns.push(m))).toEqual(argv);
		expect(warns).toHaveLength(0);
	});

	test("resolve returning undefined → no rewrite (deferred to SDK)", () => {
		const argv = ["-e", "workflow", "-p", "hi"];
		expect(rewriteExtensionArgs(argv, () => undefined)).toEqual(argv);
	});
});

describe("suppressResolvedArgv", () => {
	const argv = ["-ne", "-e", "/a/ext.ts", "--skill", "/a/skills", "-e", "/b/ext.js"];

	test("noExtensions strips -e pairs, keeps --skill and bare -ne", () => {
		expect(suppressResolvedArgv(argv, { noExtensions: true })).toEqual([
			"-ne",
			"--skill",
			"/a/skills",
		]);
	});

	test("noSkills strips --skill pairs only", () => {
		expect(suppressResolvedArgv(argv, { noSkills: true })).toEqual([
			"-ne",
			"-e",
			"/a/ext.ts",
			"-e",
			"/b/ext.js",
		]);
	});

	test("both flags leave only the bare -ne marker; no flags is identity", () => {
		expect(suppressResolvedArgv(argv, { noExtensions: true, noSkills: true })).toEqual(["-ne"]);
		expect(suppressResolvedArgv(argv, {})).toEqual(argv);
	});

	test("--extension long form is stripped like -e", () => {
		expect(
			suppressResolvedArgv(["--extension", "/a/ext.ts", "--skill", "/s"], { noExtensions: true }),
		).toEqual(["--skill", "/s"]);
	});
});

describe("runtimeDependencyNames", () => {
	test("returns dependencies when only those are declared", () => {
		expect(runtimeDependencyNames({ dependencies: { "js-yaml": "^4.0.0" } })).toEqual(["js-yaml"]);
	});

	test("returns peerDependencies (the pi-tui regression)", () => {
		// @earendil-works/pi-tui is declared as a peerDependency in several
		// extensions; the probe MUST surface it or the self-heal in check-deps.ts
		// never installs it, and pi crashes with "Cannot find module" on launch.
		expect(
			runtimeDependencyNames({ peerDependencies: { "@earendil-works/pi-tui": "0.80.10" } }),
		).toEqual(["@earendil-works/pi-tui"]);
	});

	test("returns devDependencies (typebox is a runtime import in some exts)", () => {
		expect(runtimeDependencyNames({ devDependencies: { typebox: "^1.3.6" } })).toEqual(["typebox"]);
	});

	test("unions + dedupes all three sections, dependencies-first order", () => {
		const names = runtimeDependencyNames({
			dependencies: { "js-yaml": "^4.0.0", shared: "*" },
			peerDependencies: { "@earendil-works/pi-tui": "0.80.10", shared: "*" },
			devDependencies: { typebox: "^1.3.6" },
		});
		expect(names).toEqual(["js-yaml", "shared", "@earendil-works/pi-tui", "typebox"]);
	});

	test("empty/undefined sections → empty array", () => {
		expect(runtimeDependencyNames({})).toEqual([]);
	});
});
