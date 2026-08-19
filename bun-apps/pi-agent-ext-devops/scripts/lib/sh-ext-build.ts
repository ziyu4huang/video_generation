/**
 * sh-ext-build.ts — build ONE extension package for a pi-agent-sh deploy.
 *
 * Output per extension: <outDir>/{ext.cjs, ext.json, <skills dirs>}.
 *
 * The bundle is cjs with the host module whitelist marked --external, so the
 * core can serve those specifiers from its own embedded copies (see
 * bun-apps/pi-agent/src/sh/host-modules.ts for WHY that matters). Two gates run
 * on every build:
 *   1. scanForeignSpecifiers — nothing outside the whitelist may remain
 *      unresolved, or the extension would fail to load on the user's machine.
 *   2. loadProbe — the emitted bundle is actually loaded the way the runtime
 *      loader loads it. This is what catches a change in bun's cjs output shape
 *      at deploy time instead of at user runtime.
 *   4. scanForeignPaths — no BUILD MACHINE absolute path may survive in the
 *      bundle. Gate 1 sees bare specifiers only, which is how two real defects
 *      shipped: power-tool's sdk-patch required a derived absolute path into
 *      the SDK's link-farm dir (so its polyfill silently never applied), and
 *      bun's cjs output rewrote playwright-core's `__dirname` to the builder's
 *      install cache (so the tree was not relocatable).
 *
 * The numbering matches docs/deploy-sh.md; gate 3 (dual-state --ext-list) is a
 * whole-deploy check and lives in deploy-sh.ts.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { extractBareSpecifiers } from "./build-extensions.ts";
import { evaluateExtModule, EXT_DIR_SPEC } from "../../../pi-agent/src/sh/ext-loader.ts";
// The builtin list is the CORE's — a second copy here would drift, and the gate
// would then disagree with the runtime it is supposed to be simulating.
import { isBuiltinSpecifier } from "../../../pi-agent/src/sh/host-modules.ts";
import type { ShExtConfig } from "./sh-config.ts";

/**
 * Host modules are resolved from pi-agent's own package, not from the bundle's
 * output dir: the output lives in the deploy tree (or a temp dir) with no
 * node_modules, so resolving from there silently degrades every host module to
 * a stub and the probe stops proving anything.
 */
const PI_AGENT_DIR = resolve(import.meta.dir, "..", "..", "..", "pi-agent");

export interface BuildExtOptions {
	ext: ShExtConfig;
	/**
	 * Root of the deploy tree being written (the staging dir during a full
	 * deploy). Gate 4 treats paths under it as legitimate; without it the gate
	 * would flag the extension's own output.
	 */
	deployRoot: string;
	/** Absolute path to bun-apps/. */
	bunAppsDir: string;
	/** Absolute path to the extension's output dir (…/ext/<name>). */
	outDir: string;
	hostApi: number;
	hostModules: readonly string[];
	sourceSha: string;
	builtAt: string;
}

export interface BuildExtResult {
	name: string;
	bytes: number;
	hostModules: string[];
	vendored: string[];
}

/**
 * Does `spec` match one of the allowed entries? An entry ending in `/*` matches
 * any subpath of that package — the form bun's `--external` takes for a package
 * whose internals are unresolvable (`chromium-bidi/*`), where the specifier that
 * actually survives in the bundle is a deep path like
 * `chromium-bidi/lib/cjs/bidiMapper/BidiMapper`.
 */
export function matchesAllowed(spec: string, allowed: readonly string[]): boolean {
	for (const entry of allowed) {
		if (entry === spec) return true;
		if (entry.endsWith("/*") && spec.startsWith(entry.slice(0, -1))) return true;
	}
	return false;
}

/** Bare specifiers left in the bundle that neither the host nor the config allows. */
export function scanForeignSpecifiers(code: string, allowed: readonly string[]): string[] {
	const foreign = new Set<string>();
	for (const spec of extractBareSpecifiers(code)) {
		if (isBuiltinSpecifier(spec)) continue;
		if (matchesAllowed(spec, allowed)) continue;
		foreign.add(spec);
	}
	return [...foreign];
}

/**
 * Load the built bundle exactly as the runtime loader does. Throws on any problem.
 *
 * The probe hands over the REAL host modules, resolved from the build machine's
 * workspace. A stub object is not enough: extension bundles run top-level code
 * against these modules (typebox schema literals, pi's defineTool), so a fake
 * fails on code the deployed core executes fine. A host module that cannot be
 * resolved here is a hard error rather than a stub — degrading it silently is
 * what made an earlier version of this probe pass while proving nothing.
 */
export function loadProbe(
	cjsPath: string,
	hostModules: readonly string[],
	resolveFrom = PI_AGENT_DIR,
	hostModuleIds: readonly string[] = hostModules,
): void {
	const code = readFileSync(cjsPath, "utf8");
	const nodeRequire = createRequire(join(resolveFrom, "package.json"));
	const probeRequire = (spec: string): unknown => {
		// Node/Bun builtins are resolved for real: a minified bundle calls
		// require("module")/require("node:fs") for its own interop shims, and those
		// are not host modules — rejecting them would fail every real bundle.
		if (isBuiltinSpecifier(spec)) return nodeRequire(spec);
		if (!matchesAllowed(spec, hostModules)) throw new Error(`bundle required non-host module "${spec}"`);
		try {
			// Bun.resolveSync honors the workspace's isolated linker (packages live
			// in the global store, reachable only through that resolution), which a
			// bare createRequire from the package dir cannot follow.
			return nodeRequire(Bun.resolveSync(spec, resolveFrom));
		} catch (e) {
			// A declared runtime external is allowed to be unresolvable here: that is
			// precisely why it was left out of the bundle. Only a HOST module failing
			// to resolve means the build machine is broken.
			if (!hostModuleIds.includes(spec)) return new Proxy({}, { get: () => () => undefined });
			throw new Error(
				`host module "${spec}" could not be resolved from ${resolveFrom}: ${e instanceof Error ? e.message : String(e)}. ` +
					`The core embeds it, so the build machine must be able to resolve it too — run \`bun install\` in bun-apps/.`,
			);
		}
	};
	const exports = evaluateExtModule(code, cjsPath, join(cjsPath, ".."), probeRequire);
	if (typeof exports.default !== "function") {
		throw new Error(`${cjsPath}: bundle has no callable default export`);
	}
}

/**
 * Absolute paths that give away the BUILD MACHINE's layout: the builder's home
 * directory (where bun's install cache and link farm live) or the repo it built
 * from. Anything under the deploy tree itself is fine, and so is `$HOME/.pi` —
 * the agent's own per-user state dir, which is addressed by absolute path on
 * every machine by design.
 *
 * Deliberately narrow. A generic "any quoted absolute path" scan drowns in
 * false positives — minified bundles are full of URL paths ("/v1/chat/…"),
 * "/dev/null", and "/proc/self" — and a gate that cries wolf gets disabled.
 * These two roots are where the two real defects came from.
 *
 * A `file://` URL is a path in disguise: `createRequire("file:///Users/…")`
 * bakes the build machine's layout just as much as the bare absolute path,
 * and starts with `f` — so the quote-then-slash anchor alone would miss it.
 * The prefix is stripped before matching.
 */
export function scanForeignPaths(
	code: string,
	deployRoot: string,
	roots: { home?: string; repo?: string } = {},
): string[] {
	const home = roots.home ?? homedir();
	const repo = roots.repo ?? resolve(PI_AGENT_DIR, "..", "..");
	const piState = join(home, ".pi");
	const found = new Set<string>();
	for (const m of code.matchAll(/["'`]((?:file:\/\/)?\/[^"'`\n]{4,}?)["'`]/g)) {
		const p = m[1]!.replace(/^file:\/\//, "");
		if (p.startsWith(deployRoot)) continue;
		if (p === piState || p.startsWith(`${piState}/`)) continue;
		if (p.startsWith(`${home}/`) || p.startsWith(`${repo}/`)) found.add(p);
	}
	return [...found];
}

/**
 * Rewrite `import("<vendored>")` into `Promise.resolve(require("<vendored>"))`.
 *
 * Vendoring alone is not enough for a dynamic import. The core evaluates an
 * extension bundle through an indirect eval and hands it OUR require, but a
 * real `import()` is not routed through that require — inside a compiled binary
 * it resolves against the executable's virtual root and fails with
 * `Cannot find package 'playwright-core' from '/$bunfs/root/pi-agent'`
 * (measured). Routing it through require puts it back on the loader's
 * resolution path, where the ext-local fallback finds the vendored copy.
 *
 * Bun's `require()` of playwright-core's ESM entry returns a namespace with the
 * named exports intact, so the `const { chromium } = await import(...)` shape at
 * the call site keeps working.
 *
 * Throws if a vendored specifier still appears in a dynamic import afterwards —
 * a rewrite that silently matched nothing is the failure mode this whole gate
 * family exists to prevent.
 */
export function rewriteVendoredDynamicImports(code: string, vendor: readonly string[]): string {
	let out = code;
	for (const spec of vendor) {
		const q = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		out = out.replace(new RegExp(`import\\(\\s*(["'\`])${q}\\1\\s*\\)`, "g"), `Promise.resolve(require("${spec}"))`);
		if (new RegExp(`import\\(\\s*["'\`]${q}["'\`]`).test(out)) {
			throw new Error(`rewriteVendoredDynamicImports: "${spec}" still dynamically imported after rewrite`);
		}
	}
	return out;
}

/**
 * Copy a vendored package verbatim into <outDir>/node_modules/<pkg>/.
 *
 * `dereference` matters: the workspace's isolated linker puts packages in a
 * global store reached through symlinks, and a symlinked deploy tree would
 * point back at the build machine — the exact failure vendoring exists to fix.
 */
export function vendorPackage(spec: string, outDir: string, resolveFrom: string): string {
	const pkgJson = Bun.resolveSync(`${spec}/package.json`, resolveFrom);
	const srcDir = resolve(pkgJson, "..");
	const destDir = join(outDir, "node_modules", spec);
	mkdirSync(resolve(destDir, ".."), { recursive: true });
	cpSync(srcDir, destDir, { recursive: true, dereference: true });
	return destDir;
}

/** "@scope/name/sub" → "@scope/name"; "pkg/sub" → "pkg". */
function packageRoot(spec: string): string {
	const parts = spec.split("/");
	return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

export async function buildExtPackage(opts: BuildExtOptions): Promise<BuildExtResult> {
	const pkgDir = resolve(opts.bunAppsDir, opts.ext.package);
	const entryAbs = resolve(pkgDir, opts.ext.entry);
	if (!existsSync(entryAbs)) throw new Error(`entry not found: ${entryAbs}`);

	if (existsSync(opts.outDir)) rmSync(opts.outDir, { recursive: true, force: true });
	mkdirSync(opts.outDir, { recursive: true });

	const cjsPath = join(opts.outDir, "ext.cjs");
	// Host modules + the extension's own declared runtime externals. The two are
	// different promises: a host module IS provided by the core, a runtime
	// external is merely not bundled.
	// Vendored packages are external to the bundle as well — they ship as real
	// directories and are resolved at runtime from the extension's own dir.
	const allExternals = [...opts.hostModules, ...opts.ext.externals, ...opts.ext.vendor];
	// #pi/ext-dir is served by the loader's injected require (the extension's own
	// deployed dir), never by the bundler — bun would otherwise try and fail to
	// resolve the # subpath import at build time.
	allExternals.push(EXT_DIR_SPEC);
	const externalFlags = allExternals.flatMap((m) => ["--external", m]);
	// Subpath imports need their own external pattern: "typebox" does not cover
	// "typebox/value" as a bundler external in every bun version.
	const wildcardFlags = [...new Set(allExternals.map((m) => `${packageRoot(m)}/*`))].flatMap((p) => [
		"--external",
		p,
	]);

	const proc = Bun.spawn(
		[
			"bun",
			"build",
			entryAbs,
			"--target=bun",
			"--format=cjs",
			`--outfile=${cjsPath}`,
			"--minify",
			...externalFlags,
			...wildcardFlags,
		],
		{ stdout: "pipe", stderr: "pipe", cwd: pkgDir },
	);
	const code = await proc.exited;
	if (code !== 0) {
		// Surface bun's own diagnostic: "bun build failed (exit 1)" alone gives the
		// operator nothing to act on, and the usual cause (an undeclared dep) is
		// named only in bun's stderr.
		const stderr = (await new Response(proc.stderr).text()).trim();
		throw new Error(`bun build failed for ${opts.ext.name} (exit ${code})${stderr ? `:\n${stderr}` : ""}`);
	}

	// ── Vendored dynamic imports → require ───────────────────────────────────
	// Before any gate reads the bundle, so the gates see what actually ships.
	let built = readFileSync(cjsPath, "utf8");
	if (opts.ext.vendor.length > 0) {
		built = rewriteVendoredDynamicImports(built, opts.ext.vendor);
		writeFileSync(cjsPath, built);
	}

	// ── Gate 1: nothing foreign may remain unresolved ────────────────────────
	const foreign = scanForeignSpecifiers(built, allExternals);
	if (foreign.length > 0) {
		throw new Error(
			`${opts.ext.name}: bundle references specifier(s) the host does not provide: ${foreign.join(", ")}. ` +
				`Either add them to hostModules (and to src/sh/host-modules.ts) or make the bundler inline them.`,
		);
	}

	// ── Gate 2: it loads the way the runtime loads it ─────────────────────────
	loadProbe(cjsPath, allExternals, PI_AGENT_DIR, opts.hostModules);

	// ── Vendored packages ────────────────────────────────────────────────────
	// Resolved from the EXTENSION's package dir, not pi-agent's: a vendored dep
	// is declared by the extension that uses it, and pi-agent has no edge to it.
	for (const spec of opts.ext.vendor) vendorPackage(spec, opts.outDir, pkgDir);

	// ── Gate 4: no build-machine path may survive in the bundle ──────────────
	// Runs after vendoring so the deploy-tree exemption covers what we just
	// wrote.
	const foreignPaths = scanForeignPaths(built, opts.deployRoot);
	if (foreignPaths.length > 0) {
		throw new Error(
			`${opts.ext.name}: bundle bakes in build-machine path(s): ${foreignPaths.slice(0, 5).join(", ")}` +
				`${foreignPaths.length > 5 ? ` (+${foreignPaths.length - 5} more)` : ""}. ` +
				`The deploy tree must be relocatable — vendor the package (vendor:) instead of bundling it, ` +
				`or reach the dependency by bare specifier so the host can serve it.`,
		);
	}

	// ── Skills ───────────────────────────────────────────────────────────────
	for (const rel of opts.ext.skills) {
		cpSync(resolve(pkgDir, rel), join(opts.outDir, rel), { recursive: true, dereference: true });
	}

	// ── Copied data dirs ─────────────────────────────────────────────────────
	// Same verbatim copy as skills, but NOT forwarded as --skill by the loader —
	// runtime data the extension reads relative to its own directory.
	for (const rel of opts.ext.copy) {
		cpSync(resolve(pkgDir, rel), join(opts.outDir, rel), { recursive: true, dereference: true });
	}

	// ── Manifest ─────────────────────────────────────────────────────────────
	const usedHostModules = opts.hostModules.filter((m) => built.includes(`"${m}"`));
	const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
		name?: string;
		version?: string;
	};
	const manifest = {
		name: opts.ext.name,
		package: pkgJson.name ?? opts.ext.package,
		version: pkgJson.version ?? "0.0.0",
		hostApi: opts.hostApi,
		entry: "ext.cjs",
		order: opts.ext.order,
		enabled: true,
		skills: opts.ext.skills,
		copy: opts.ext.copy,
		hostModules: usedHostModules,
		runtimeExternals: opts.ext.externals,
		vendored: opts.ext.vendor,
		builtAt: opts.builtAt,
		sourceSha: opts.sourceSha,
	};
	writeFileSync(join(opts.outDir, "ext.json"), `${JSON.stringify(manifest, null, 2)}\n`);

	return {
		name: opts.ext.name,
		bytes: statSync(cjsPath).size,
		hostModules: usedHostModules,
		vendored: opts.ext.vendor,
	};
}
