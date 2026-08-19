/**
 * ext-loader.ts — discovers and loads sh-mode extension packages from
 * <deployDir>/ext/<name>/.
 *
 * CONTRACT: every failure is local. A missing ext root, a corrupt ext.json, an
 * incompatible hostApi, a throwing bundle — each skips exactly one extension
 * and is reported in `skipped`; the core always boots. The design requirement
 * "deleting ext/ still runs" is this function returning empty arrays.
 *
 * The cjs wrapper: extension bundles are built with `bun build --format=cjs`,
 * whose output is `// @bun @bun-cjs` followed by
 * `(function(exports, require, module, __filename, __dirname){…})`. Evaluating
 * that text yields the wrapper function, which we call with OUR require —
 * verified to work inside a `bun build --compile` binary.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { isBuiltinSpecifier } from "./host-modules.ts";
import { parseExtManifest, type ExtManifest, type HostContract } from "./ext-manifest.ts";

/**
 * The shape pi's `main({ extensionFactories })` consumes. `factory` is typed as
 * pi's own ExtensionFactory so the loaded set can be handed to main() without a
 * cast — the runtime check below (`typeof factory === "function"`) is what
 * actually enforces it, since a bundle read off disk carries no type.
 */
export interface LoadedExtension {
	name: string;
	factory: ExtensionFactory;
}

export interface SkippedExtension {
	name: string;
	reason: string;
}

export interface LoadResult {
	factories: LoadedExtension[];
	skillPaths: string[];
	loaded: string[];
	skipped: SkippedExtension[];
}

export interface LoadOptions {
	/** Absolute path to the `ext` directory. */
	extRoot: string;
	host: HostContract;
	/** Module provider handed to each bundle (production: hostRequire). */
	require: (spec: string) => unknown;
}

/**
 * Wrap the host require with a per-extension fallback that resolves from the
 * extension's OWN directory.
 *
 * A vendored package (deploy-config `vendor:`) ships as a real
 * <ext>/node_modules/<pkg>/ tree rather than being inlined, because bun's cjs
 * output rewrites `__dirname` to the build machine's path — fine for code that
 * never looks at it, fatal for a package that locates its own resources that
 * way (playwright-core). Resolving it from the extension dir gives it a real
 * `__dirname` inside the deploy.
 *
 * MEASUREMENT (why the manual resolver): inside a `bun build --compile` binary,
 * `createRequire(<real path>)` and `Bun.resolveSync` CANNOT resolve PACKAGES
 * from the real filesystem — module resolution is virtualized onto $bunfs and
 * "Cannot find package 'x' from <real path>" is the result. Requiring an
 * ABSOLUTE FILE path still works, so the fallback resolves the vendored entry
 * file by reading the vendored package.json (exports → require/default/first,
 * then main) and requires that file directly.
 *
 * Host modules still win: the fallback is only consulted after hostRequire
 * throws, so a vendored copy can never shadow the shared runtime and split a
 * singleton.
 */
export function extRequire(dir: string, hostRequire: (spec: string) => unknown): (spec: string) => unknown {
	let local: NodeJS.Require | null = null;
	return (spec: string): unknown => {
		try {
			return hostRequire(spec);
		} catch (hostError) {
			try {
				const vendored = resolveVendoredEntryFile(spec, dir);
				if (vendored !== null) {
					local ??= createRequire(join(dir, "package.json"));
					return local(vendored);
				}
				// Not a vendored package — still let createRequire try (a relative
				// file require inside the ext dir reaches this path).
				local ??= createRequire(join(dir, "package.json"));
				return local(spec);
			} catch {
				// Report the HOST's error: it names the contract the extension
				// violated. The fallback failing merely means "not vendored either".
				throw hostError;
			}
		}
	};
}

/** "@scope/name/sub" → "@scope/name"; "pkg/sub" → "pkg". */
function packageRootOf(spec: string): string {
	const parts = spec.split("/");
	return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/**
 * Absolute entry-file path for a vendored `spec` under `<dir>/node_modules/`,
 * or null when the spec is not a vendored package there. Handles the common
 * package.json shapes: `exports` (string, conditional object, subpath keys)
 * and `main`. Anything fancier (wildcard patterns, browser maps) falls back to
 * main/index probing — vendored packages in this repo are ordinary ones.
 */
function resolveVendoredEntryFile(spec: string, dir: string): string | null {
	if (isBuiltinSpecifier(spec) || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("#")) {
		return null;
	}
	const root = packageRootOf(spec);
	const pkgDir = join(dir, "node_modules", root);
	const pkgJsonPath = join(pkgDir, "package.json");
	if (!existsSync(pkgJsonPath)) return null;
	let pkg: Record<string, unknown>;
	try {
		pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
	const sub = spec.slice(root.length).replace(/^\//, "");

	const pickExport = (e: unknown): string | null => {
		if (typeof e === "string") return e;
		if (e !== null && typeof e === "object") {
			const o = e as Record<string, unknown>;
			// Prefer require → default → first condition, the ordering that
			// matches how these packages declare their cjs entry.
			return pickExport(o.require ?? o.default ?? Object.values(o)[0]);
		}
		return null;
	};
	const exp = pkg.exports;
	if (exp !== null && typeof exp === "object" && !Array.isArray(exp)) {
		const target = sub === "" ? (exp as Record<string, unknown>)["."] : (exp as Record<string, unknown>)[`./${sub}`];
		const rel = pickExport(target);
		if (rel !== null) return join(pkgDir, rel);
	}

	const tryFiles = (base: string): string | null => {
		for (const candidate of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, join(base, "index.js"), join(base, "index.mjs")]) {
			try {
				if (statSync(candidate).isFile()) return candidate;
			} catch {
				// keep probing
			}
		}
		return null;
	};
	if (sub !== "") {
		const bySub = tryFiles(join(pkgDir, sub));
		if (bySub !== null) return bySub;
	}
	const mainRel = typeof pkg.main === "string" ? pkg.main : "index.js";
	return tryFiles(join(pkgDir, mainRel));
}

interface Candidate {
	dir: string;
	manifest: ExtManifest;
}

/**
 * Reserved pseudo-specifier an extension requires() to learn its own deployed
 * directory at runtime: `require("#pi/ext-dir")` → the absolute `ext/<name>/`
 * path. Needed because bun's cjs output REBINDS `__dirname`/`__filename` inside
 * the bundle to the paths the entry had on the BUILD MACHINE (the playwright
 * defect), so the wrapper arguments this loader passes are shadowed by the time
 * extension code runs — the injected require is the one identity-preserving
 * channel left. Served here (in evaluateExtModule) so every caller — the
 * runtime loader and the build-time load probe — honors it identically.
 */
export const EXT_DIR_SPEC = "#pi/ext-dir";

/** Evaluate a bun cjs bundle and return its module.exports. */
export function evaluateExtModule(
	code: string,
	filename: string,
	dirname: string,
	requireFn: (spec: string) => unknown,
): Record<string, unknown> {
	// Indirect eval keeps the bundle out of this module's scope.
	const wrapper = (0, eval)(code);
	if (typeof wrapper !== "function") {
		throw new Error("bundle is not a cjs wrapper function — expected `bun build --format=cjs` output");
	}
	const mod = { exports: {} as Record<string, unknown> };
	const selfDirRequire = (spec: string): unknown =>
		spec === EXT_DIR_SPEC ? dirname : requireFn(spec);
	wrapper(mod.exports, selfDirRequire, mod, filename, dirname);
	return mod.exports;
}

export function loadExtensions(opts: LoadOptions): LoadResult {
	const result: LoadResult = { factories: [], skillPaths: [], loaded: [], skipped: [] };
	if (!existsSync(opts.extRoot)) return result;

	// ── Phase 1: read + validate every manifest (no extension code runs yet) ──
	const candidates: Candidate[] = [];
	let entries: string[];
	try {
		entries = readdirSync(opts.extRoot);
	} catch (e) {
		result.skipped.push({ name: "*", reason: `cannot read ext root: ${errMsg(e)}` });
		return result;
	}
	for (const name of entries.sort()) {
		const dir = join(opts.extRoot, name);
		const manifestPath = join(dir, "ext.json");
		// A directory with no ext.json is not an extension — ignore it silently.
		if (!existsSync(manifestPath)) continue;

		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(manifestPath, "utf8"));
		} catch (e) {
			result.skipped.push({ name, reason: `ext.json is not valid JSON: ${errMsg(e)}` });
			continue;
		}
		const parsed = parseExtManifest(raw, name, opts.host);
		if (!parsed.ok) {
			result.skipped.push({ name, reason: parsed.reason });
			continue;
		}
		if (!parsed.manifest.enabled) {
			result.skipped.push({ name, reason: "disabled in ext.json" });
			continue;
		}
		if (!existsSync(join(dir, parsed.manifest.entry))) {
			result.skipped.push({ name, reason: `entry file not found: ${parsed.manifest.entry}` });
			continue;
		}
		candidates.push({ dir, manifest: parsed.manifest });
	}

	// ── Phase 2: load in (order, name) order ────────────────────────────────
	candidates.sort((a, b) =>
		a.manifest.order !== b.manifest.order
			? a.manifest.order - b.manifest.order
			: a.manifest.name.localeCompare(b.manifest.name),
	);

	for (const { dir, manifest } of candidates) {
		const entryPath = join(dir, manifest.entry);
		try {
			const exports = evaluateExtModule(
				readFileSync(entryPath, "utf8"),
				entryPath,
				dir,
				extRequire(dir, opts.require),
			);
			const factory = exports.default;
			if (typeof factory !== "function") {
				result.skipped.push({ name: manifest.name, reason: "bundle has no callable default export" });
				continue;
			}
			result.factories.push({ name: manifest.name, factory: factory as LoadedExtension["factory"] });
			result.loaded.push(manifest.name);
			for (const rel of manifest.skills) {
				const abs = join(dir, rel);
				if (existsSync(abs)) result.skillPaths.push(abs);
			}
		} catch (e) {
			result.skipped.push({ name: manifest.name, reason: errMsg(e) });
		}
	}

	return result;
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
