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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
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

interface Candidate {
	dir: string;
	manifest: ExtManifest;
}

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
	wrapper(mod.exports, requireFn, mod, filename, dirname);
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
			const exports = evaluateExtModule(readFileSync(entryPath, "utf8"), entryPath, dir, opts.require);
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
