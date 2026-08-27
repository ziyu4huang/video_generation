/**
 * ext-build.ts — build ONE extension package for a s2-agent-sh deploy.
 *
 * Output per extension: <outDir>/{ext.cjs, ext.json, <skills dirs>}.
 *
 * The bundle is cjs with the host module whitelist marked --external, so the
 * core can serve those specifiers from its own embedded copies (see
 * bun-apps/s2-agent/src/sh/host-modules.ts for WHY that matters). Two gates run
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
 * The numbering is the gate sequence's stable id space (report + tests cite
 * these); gate 3 (dual-state --ext-list) is a whole-deploy check and lives in
 * run.ts, and gate 5 (offline containment of the whole TREE — symlink
 * escapes, binary paths, vendored closure) lives in offline-gate.ts.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { evaluateExtModule, EXT_DIR_SPEC, extRequire } from "../../../../s2-agent/src/sh/ext-loader.ts";
// The builtin list is the CORE's — a second copy here would drift, and the gate
// would then disagree with the runtime it is supposed to be simulating.
import { isBuiltinSpecifier } from "../../../../s2-agent/src/sh/host-modules.ts";
import { isRuntimeDeadFile, vendorClosure } from "./vendor-closure.ts";
import { walk } from "./fs.ts";
import type { ShExtConfig } from "./config.ts";

/**
 * Host modules are resolved from s2-agent's own package, not from the bundle's
 * output dir: the output lives in the deploy tree (or a temp dir) with no
 * node_modules, so resolving from there silently degrades every host module to
 * a stub and the probe stops proving anything.
 */
const PI_AGENT_DIR = resolve(import.meta.dir, "..", "..", "..", "..", "s2-agent");

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
	/**
	 * Per-gate timing callback, fired after each of Gates 1/1b/2/4 passes —
	 * the deploy report's gate matrix. Only called on pass: a failed gate
	 * throws and the deploy aborts before any report is written, so there is
	 * no "fail" observation to report.
	 */
	onGate?: (id: string, ms: number) => void;
	/**
	 * Cross-OS vendoring (crossos-deploy t05): the TARGET platform the
	 * vendored closure is filtered for (os/cpu/libc match). Absent → the
	 * build host, the pre-t05 behavior.
	 */
	vendorPlatform?: NodeJS.Platform;
	vendorArch?: string;
	vendorLibc?: "glibc" | "musl" | null;
}

/** Time one gate body; report the duration to opts.onGate on pass. */
function timedGate(opts: BuildExtOptions, id: string, run: () => void): void {
	const t0 = performance.now();
	run();
	opts.onGate?.(id, performance.now() - t0);
}

export interface BuildExtResult {
	name: string;
	bytes: number;
	hostModules: string[];
	vendored: string[];
}

/**
 * A specifier that could plausibly be a module id. Filters the regex's
 * structural false positives (captured operators, fragments with whitespace or
 * brackets) before a caller ever sees them.
 */
function isValidModuleSpec(s: string): boolean {
	if (s.length < 2) return false;
	if (/[\s(){}=;<>+]/.test(s)) return false;
	return true;
}

// The `from` / `import(` alternation matches ESM import + re-export forms.
// The `(?<![\w$-])` lookbehind on `from` is REQUIRED: without it the regex also
// matches a `from` that is merely the TAIL of a larger token — most painfully
// the string `"sql-delete-from"` (is-unsafe's SQL-injection catalog, a
// transitive dep of fast-xml-parser). There `from` is followed by the string's
// closing `"`, so the regex captured `,description:` as a bogus bare specifier
// and aborted the whole deploy. A real `from` keyword is never preceded by a
// word char or `-` (minified `export{a}from"x"` → preceded by `}`;
// `import a from"x"` → preceded by a space), so the lookbehind rejects only the
// false positives. `import(` needs no anchor (the `(` disambiguates).
const BARE_SPEC_RE =
	/(?:((?<![\w$-])from|import\()\s*)(["'])([^"'#.][^"'']*?)\2/g;

/**
 * Scan bundled code for ESM bare specifiers (`from "x"`, `import("x")`,
 * re-export `}from"x"`). Pure + exported so the notoriously fragile regex is
 * unit-testable. Returns the de-duplicated specifiers in first-seen order;
 * template-concat and obviously invalid specs are filtered here so callers see
 * only plausible specifiers.
 *
 * Moved here from the retired build-extensions.ts, whose only surviving
 * consumer this was: Gate 1 below.
 */
export function extractBareSpecifiers(code: string): string[] {
	const bare = new Set<string>();
	for (const m of code.matchAll(BARE_SPEC_RE)) {
		const spec = m[3];
		if (spec.includes("${") || spec.includes(" + ")) continue;
		if (!isValidModuleSpec(spec)) continue;
		bare.add(spec);
	}
	return [...bare];
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

export interface ExtBundle {
	/** The module exports object evaluated with the runtime loader contract. */
	exports: Record<string, unknown>;
	/** The deployed ext dir the bundle was evaluated against (#pi/ext-dir). */
	extDir: string;
}

/**
 * Evaluate a deployed ext.cjs bundle the way the runtime loader does — the
 * shared preamble of `executeExtTool` and the tool-gate fire probe, so the two
 * can never disagree about host identity, require semantics, or the
 * `#pi/ext-dir` serving.
 *
 * Host modules resolve from the build machine's workspace (never from the
 * deploy tree — that tree has no node_modules and every host module would
 * silently degrade to a stub and the probe would stop proving anything).
 */
export async function evaluateExtBundle(
	cjsPath: string,
	hostModules: readonly string[],
	opts: { resolveFrom?: string } = {},
): Promise<ExtBundle> {
	const code = readFileSync(cjsPath, "utf8");
	const extDir = join(cjsPath, "..");
	const resolveFrom = opts.resolveFrom ?? PI_AGENT_DIR;
	const nodeRequire = createRequire(join(resolveFrom, "package.json"));
	const allowed = (spec: string): boolean =>
		matchesAllowed(spec, hostModules) || hostModules.some((e) => e !== "" && spec.startsWith(`${e}/`));
	// Same contract as the runtime: host modules served by the host require
	// first, then the ext dir's own require for vendored packages (the deployed
	// vendored copy at <extDir>/node_modules, loaded for real — bun's require
	// interops ESM vendored packages).
	const hostRequireForProbe = (spec: string): unknown => {
		if (isBuiltinSpecifier(spec)) return nodeRequire(spec);
		if (!allowed(spec)) throw new EvalError(`bundle required non-host module "${spec}"`);
		return nodeRequire(Bun.resolveSync(spec, resolveFrom));
	};
	const probeRequire = extRequire(extDir, hostRequireForProbe) as unknown as {
		(spec: string): unknown;
		resolve?: (spec: string) => string;
	};
	// require.resolve returns the PATH (matching require.resolve semantics —
	// the bundle takes dirname() of it), resolved against the DEPLOYED ext dir
	// so the probe reads the deployed vendored copy, not the build machine's.
	probeRequire.resolve = (spec: string): string =>
		isBuiltinSpecifier(spec) ? nodeRequire.resolve(spec) : Bun.resolveSync(spec, join(extDir, "__probe__.ts"));
	const exports = evaluateExtModule(code, cjsPath, extDir, probeRequire);
	if (typeof exports.default !== "function") {
		throw new Error(`${cjsPath}: bundle has no callable default export`);
	}
	return { exports: exports as Record<string, unknown>, extDir };
}

/**
 * Evaluate a deployed ext.cjs bundle the way the runtime loader does and
 * execute ONE of its registered tools — no model, no agent loop. This is what
 * the file2md OCR e2e probe uses: the deployed bundle's own pipeline runs
 * against the deployed assets resolved via `#pi/ext-dir` (vendored wasm +
 * copied lang data), so a broken asset layout fails here instead of on a user
 * machine.
 */
export async function executeExtTool(
	cjsPath: string,
	toolName: string,
	params: Record<string, unknown>,
	hostModules: readonly string[],
	opts: { resolveFrom?: string } = {},
): Promise<unknown> {
	const { exports } = await evaluateExtBundle(cjsPath, hostModules, opts);
	const tools: Array<{ name: string; execute: (...a: unknown[]) => unknown }> = [];
	(exports.default as (api: unknown) => void)({
		on: () => undefined,
		registerTool: (tool: { name: string; execute: (...a: unknown[]) => unknown }) => tools.push(tool),
	});
	const tool = tools.find((t) => t.name === toolName);
	if (!tool) {
		throw new Error(`${cjsPath}: tool "${toolName}" not registered (registered: ${tools.map((t) => t.name).join(", ")})`);
	}
	return await tool.execute("e2e-probe", params, undefined, undefined, undefined);
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
	// Separator-normalize both sides: a WINDOWS build host (crossos t06 makes
	// windows-latest one) bakes `C:\Users\…` paths, and the allow-list prefixes
	// must compare against them with one spelling.
	const norm = (s: string) => s.replace(/\\/g, "/");
	const home = norm(roots.home ?? homedir());
	const repo = norm(roots.repo ?? resolve(PI_AGENT_DIR, "..", ".."));
	const root = norm(deployRoot);
	const piState = `${home}/.pi`;
	const found = new Set<string>();
	// Drive-letter absolute paths (`C:\…` / `C:/…`) alongside POSIX `/…` —
	// the win32 build-host spelling a leading-`/`-only anchor would miss.
	for (const m of code.matchAll(/["'`]((?:file:\/\/)?(?:[A-Za-z]:[\/\\]|\/)[^"'`\n]{4,}?)["'`]/g)) {
		const p = norm(m[1]!.replace(/^file:\/\//, ""));
		if (p.startsWith(root)) continue;
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
 * `Cannot find package 'playwright-core' from '/$bunfs/root/s2-agent'`
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

/** All literal dynamic-import specifiers in `code` (template concat skipped). */
function dynamicImportSpecs(code: string): string[] {
	const specs = new Set<string>();
	for (const m of code.matchAll(/import\(\s*(["'`])([^"'`]+)\1\s*\)/g)) {
		const spec = m[2]!;
		if (spec.includes("${")) continue;
		specs.add(spec);
	}
	return [...specs];
}

/**
 * Rewrite every DYNAMIC import of an ALLOWED specifier (host modules, declared
 * runtime externals, vendored packages) into `Promise.resolve(require(spec))`.
 *
 * The same mechanism as rewriteVendoredDynamicImports, generalized from vendor:
 * entries to the whole allow-list. The defect it closes (2026-08-20, /websearch):
 * web-access's `await import("@earendil-works/pi-ai/compat")` — a HOST module —
 * stayed a native dynamic import in the cjs bundle. Static imports are compiled
 * to require calls inside the wrapper (routed through the loader's injected
 * require), but dynamic ones are not; in a compiled binary they resolve against
 * $bunfs and fail with `Cannot find module '…' from '/$bunfs/root/s2-agent'`.
 * Gate 1 couldn't see it — the specifier IS allowed, it just wasn't REACHABLE
 * as a dynamic import.
 *
 * Node builtins stay native: they resolve fine in a compiled binary and there
 * is no reason to touch them. Non-allowed specifiers are left for Gate 1,
 * which rejects them outright.
 */
export function rewriteAllowedDynamicImports(code: string, allowed: readonly string[]): string {
	let out = code;
	for (const spec of dynamicImportSpecs(code)) {
		if (isBuiltinSpecifier(spec)) continue;
		if (!matchesAllowed(spec, allowed)) continue;
		const q = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		out = out.replace(new RegExp(`import\\(\\s*(["'\`])${q}\\1\\s*\\)`, "g"), `Promise.resolve(require("${spec}"))`);
	}
	return out;
}

/**
 * Bare dynamic-import specifiers that remain after the rewrites — none of these
 * can resolve at runtime inside a compiled binary (that is the /websearch
 * failure mode), so a non-empty result must fail the build. Builtins,
 * relative/absolute paths, and the `#pi/…` channel are exempt.
 */
export function scanUnroutableDynamicImports(code: string): string[] {
	return dynamicImportSpecs(code).filter(
		(spec) =>
			!isBuiltinSpecifier(spec) &&
			!spec.startsWith(".") &&
			!spec.startsWith("/") &&
			!spec.startsWith("#"),
	);
}

/**
 * Rewrite the `import.meta.url` folds an INLINED asset package bakes into the
 * bundle.
 *
 * When bun bundles a package whose default asset resolution keys off its own
 * location (`new URL("x.wasm", import.meta.url)`), the cjs output folds
 * import.meta.url to `file://<build-machine-cache>/<pkg>/<file>`. For an
 * `assets:` package that JS is deliberate — the runtime passes wasmBinary /
 * asset URLs EXPLICITLY (see file2md src/assets.ts), so the default branch is
 * dead code — but Gate 4 rightly rejects ANY baked machine path, dead or not
 * (the same bundler defect could bake a live one).
 *
 * Each fold becomes `file:///__s2-inlined-assets/<pkg>/<file>`: still a valid
 * URL base, never a real path. Scoped to the registry's asset packages ONLY —
 * a fold from any other package still trips Gate 4, where a human decides.
 *
 * Shape-asserted per the rewrite family: rewriting an assets-declared ext
 * where NO fold matched is an error — that means the fold moved somewhere this
 * rewrite cannot see (or the package stopped folding), and a silent no-op is
 * the failure mode the gate family exists to prevent.
 */
export function rewriteAssetImportMetaFolds(
	code: string,
	pkgs: readonly string[],
	resolveFrom: string,
): string {
	let out = code;
	let total = 0;
	for (const pkg of pkgs) {
		const dir = resolve(Bun.resolveSync(`${pkg}/package.json`, resolveFrom), "..");
		// Counted from the INPUT (replaceAll gives no count): each occurrence is
		// one import.meta.url fold this pass neutralizes.
		const hits = code.split(`file://${dir}/`).length - 1;
		total += hits;
		out = out.replaceAll(`file://${dir}/`, `file:///__s2-inlined-assets/${pkg}/`);
	}
	if (pkgs.length > 0 && total === 0) {
		throw new Error(
			`rewriteAssetImportMetaFolds: expected import.meta.url fold(s) from asset package(s) [${pkgs.join(", ")}] — none found. ` +
				`Either the packages stopped folding import.meta.url (relax this assert) or the fold shape moved (update this rewrite).`,
		);
	}
	return out;
}

/**
 * Copy deploy asset payloads — files or dirs — from their npm packages into
 * <outDir>/<to>, verbatim.
 *
 * The `assets:` alternative to `vendor:` for asset-bearing deps whose CODE
 * bundles into ext.cjs and only the PAYLOAD needs a real path at runtime
 * (file2md's wasm OCR): no node_modules tree ships for the extension. Payloads
 * are extracted straight from the npm-installed package (resolved through the
 * workspace's isolated linker, dereferenced so no store symlink escapes) —
 * byte-for-byte copies, no rebuild, no network fetch. A missing payload fails
 * the build loudly with the fix in the message, mirroring the copy-dir gate:
 * silently shipping a bundle whose assets were dropped ships a broken ext.
 */
export function copyDeployAssets(
	assets: ReadonlyArray<{ pkg: string; from: string; to: string }>,
	outDir: string,
	resolveFrom: string,
): string[] {
	const copied: string[] = [];
	for (const a of assets) {
		const pkgJson = Bun.resolveSync(`${a.pkg}/package.json`, resolveFrom);
		const src = resolve(pkgJson, "..", a.from);
		if (!existsSync(src)) {
			throw new Error(
				`asset "${a.pkg}/${a.from}" not found at ${src} — payloads come verbatim from npm; ` +
					`run \`bun install\` in bun-apps/ (via the configured npm registry/mirror), then deploy again`,
			);
		}
		const dest = join(outDir, a.to);
		mkdirSync(resolve(dest, ".."), { recursive: true });
		cpSync(src, dest, { recursive: true, dereference: true });
		copied.push(a.to);
	}
	return copied;
}

/**
 * Copy a vendored package verbatim into <outDir>/node_modules/<pkg>/.
 *
 * `dereference` matters: the workspace's isolated linker puts packages in a
 * global store reached through symlinks, and a symlinked deploy tree would
 * point back at the build machine — the exact failure vendoring exists to fix.
 *
 * "Verbatim" excludes what cannot run — sourcemaps and typings — on the same
 * terms as copyPackageVerbatim, so the one-package and closure paths produce
 * the same tree (see isRuntimeDeadFile).
 */
export function vendorPackage(spec: string, outDir: string, resolveFrom: string): string {
	const pkgJson = Bun.resolveSync(`${spec}/package.json`, resolveFrom);
	const srcDir = resolve(pkgJson, "..");
	const destDir = join(outDir, "node_modules", spec);
	mkdirSync(resolve(destDir, ".."), { recursive: true });
	cpSync(srcDir, destDir, { recursive: true, dereference: true, filter: (src) => !isRuntimeDeadFile(src) });
	return destDir;
}

/**
 * Neutralize the hyperframes skill helper's npm-install bootstrap in the dist.
 *
 * The skills copy verbatim, and the helper's `importPackagesOrBootstrap` offers
 * a one-time `npm install --ignore-scripts` when a package is missing — the one
 * runtime install path an offline deploy must not have. With the dependency
 * closure vendored the branch is dead in practice; this patch makes it dead in
 * fact: a missing package now fails fast with a message that names what was
 * expected to be vendored, instead of reaching for the network.
 *
 * Shape-asserted like the rewrites above: a patch that silently matched
 * nothing is the failure mode this gate family exists to prevent.
 */
export function patchOfflinePackageLoader(code: string): string {
	const CONFIRM = "await confirmBootstrap(npmPackages);";
	const INSTALL = "bootstrapWithNpmInstall(npmPackages);";
	if (!code.includes(CONFIRM) || !code.includes(INSTALL)) {
		throw new Error("package-loader.mjs shape drifted — update patchOfflinePackageLoader (ext-build.ts)");
	}
	return code
		.replace(CONFIRM, 'throw new Error("package not vendored in the offline s2-agent-sh dist: " + missing.join(", "));')
		.replace(INSTALL, "");
}

/** Apply patchOfflinePackageLoader to every matching file under `dir`. */
export function patchOfflinePackageLoadersUnder(dir: string): number {
	let patched = 0;
	walk(dir, (p, isDir) => {
		if (isDir || basename(p) !== "package-loader.mjs") return;
		const code = readFileSync(p, "utf8");
		// Content sniff, not a path assumption: an unrelated package's
		// same-named file is left untouched.
		if (!code.includes("HYPERFRAMES_SKILL_BOOTSTRAP_DEPS")) return;
		writeFileSync(p, patchOfflinePackageLoader(code));
		patched++;
	});
	return patched;
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
	}
	// ── Allowed dynamic imports → require ────────────────────────────────────
	// Host modules / runtime externals too, not just vendored ones: a native
	// dynamic import cannot reach them inside a compiled binary (see the
	// rewriteAllowedDynamicImports header — the /websearch defect).
	built = rewriteAllowedDynamicImports(built, allExternals);
	// ── Asset-package import.meta.url folds → dead placeholders ────────────
	// An assets: package's JS is inlined (not vendored), and bun folds its
	// import.meta.url to the build-machine cache path. The runtime resolves
	// payloads EXPLICITLY, so the folded default is dead — but Gate 4 rejects
	// any baked path. Must run before the gates read the bundle.
	if (opts.ext.assets.length > 0) {
		built = rewriteAssetImportMetaFolds(
			built,
			[...new Set(opts.ext.assets.map((a) => a.pkg))],
			pkgDir,
		);
	}
	writeFileSync(cjsPath, built);

	// ── Gate 1: nothing foreign may remain unresolved ────────────────────────
	timedGate(opts, "1", () => {
		const foreign = scanForeignSpecifiers(built, allExternals);
		if (foreign.length > 0) {
			throw new Error(
				`${opts.ext.name}: bundle references specifier(s) the host does not provide: ${foreign.join(", ")}. ` +
					`Either add them to hostModules (and to src/sh/host-modules.ts) or make the bundler inline them.`,
			);
		}
	});

	// ── Gate 1b: no bare dynamic import may remain ───────────────────────────
	// The rewrites above turn every ALLOWED dynamic import into a require; Gate 1
	// has already rejected every non-allowed bare specifier. Anything left as a
	// native `import("<bare>")` therefore cannot resolve at runtime inside a
	// compiled binary — this is exactly how /websearch shipped broken while all
	// existing gates stayed green.
	timedGate(opts, "1b", () => {
		const unroutable = scanUnroutableDynamicImports(built);
		if (unroutable.length > 0) {
			throw new Error(
				`${opts.ext.name}: bundle keeps native dynamic import(s) that cannot resolve inside the compiled binary: ${unroutable.join(", ")}. ` +
					`Import the module statically (the cjs wrapper routes static imports through the injected require), or declare it as an external so the build rewrites it to require().`,
			);
		}
	});

	// ── Gate 2: it loads the way the runtime loads it ─────────────────────────
	timedGate(opts, "2", () => loadProbe(cjsPath, allExternals, PI_AGENT_DIR, opts.hostModules));

	// ── Vendored packages ────────────────────────────────────────────────────
	// Resolved from the EXTENSION's package dir, not s2-agent's: a vendored dep
	// is declared by the extension that uses it, and s2-agent has no edge to it.
	// The CLOSURE ships, not just the root — a half-shipped dependency tree
	// dangles at runtime with no offline remediation (see vendor-closure.ts).
	// `vendorExclude` drops closure deps the runtime never resolves; those land
	// in the manifest below so Gate 5d honours the absence as deliberate.
	const vendoredClosure =
		opts.ext.vendor.length > 0
			? vendorClosure({
					roots: opts.ext.vendor,
					resolveFrom: pkgDir,
					outDir: opts.outDir,
					exclude: opts.ext.vendorExclude,
					// Cross-OS (t05): filter native packages for the TARGET, not
					// the build host. Explicitly null libc disables filtering.
					platform: opts.vendorPlatform,
					arch: opts.vendorArch,
					libc: opts.vendorLibc,
				})
			: [];

	// ── Asset payloads (npm files/dirs → <outDir>/<to>, code is bundled) ─────
	// The vendor: alternative — no node_modules tree; payloads only. Runs
	// before Gate 4 so the deploy-tree exemption covers what we just wrote.
	const assetsCopied = copyDeployAssets(opts.ext.assets ?? [], opts.outDir, pkgDir);

	// ── Gate 4: no build-machine path may survive in the bundle ──────────────
	// Runs after vendoring so the deploy-tree exemption covers what we just
	// wrote.
	timedGate(opts, "4", () => {
		const foreignPaths = scanForeignPaths(built, opts.deployRoot);
		if (foreignPaths.length > 0) {
			throw new Error(
				`${opts.ext.name}: bundle bakes in build-machine path(s): ${foreignPaths.slice(0, 5).join(", ")}` +
					`${foreignPaths.length > 5 ? ` (+${foreignPaths.length - 5} more)` : ""}. ` +
					`The deploy tree must be relocatable — vendor the package (vendor:) instead of bundling it, ` +
					`or reach the dependency by bare specifier so the host can serve it.`,
			);
		}
	});

	// ── Skills ───────────────────────────────────────────────────────────────
	for (const rel of opts.ext.skills) {
		cpSync(resolve(pkgDir, rel), join(opts.outDir, rel), { recursive: true, dereference: true });
		patchOfflinePackageLoadersUnder(join(opts.outDir, rel));
	}

	// ── Copied data dirs ─────────────────────────────────────────────────────
	// Same verbatim copy as skills, but NOT forwarded as --skill by the loader —
	// runtime data the extension reads relative to its own directory. Copy dirs
	// may be REGENERATED build artifacts (gitignored, e.g. sv-analyzer's wasm/)
	// that a fresh clone must mirror first — a missing dir must fail the deploy
	// loudly (silently shipping a bundle without a declared copy dir ships a
	// broken extension), but with a message that names the fix, not a raw ENOENT.
	for (const rel of opts.ext.copy) {
		const src = resolve(pkgDir, rel);
		if (!existsSync(src)) {
			throw new Error(
				`${opts.ext.name}: copy dir '${rel}' not found at ${src} — mirror the built artifact first ` +
					`(e.g. run dsh-plugin/sv-analyzer/build.sh to mirror wasm/sv-analyzer.wasm), then deploy again`,
			);
		}
		cpSync(src, join(opts.outDir, rel), { recursive: true, dereference: true });
		patchOfflinePackageLoadersUnder(join(opts.outDir, rel));
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
		assets: assetsCopied,
		vendoredClosure: {
			count: vendoredClosure.length,
			// Deps intentionally not shipped: not installed or wrong platform.
			pruned: [...new Set(vendoredClosure.flatMap((n) => n.pruned))],
			// Deps intentionally not shipped: registry vendorExclude — Gate 5d
			// reads this list and treats each absence as deliberate.
			excluded: [...new Set(vendoredClosure.flatMap((n) => n.excluded))],
		},
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
