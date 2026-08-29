/**
 * ext-list.ts — the dev-mode `--ext-list` diagnostic (twin of sh/ext-list.ts).
 *
 * Dev (source) mode has no ext/ tree: its extension set comes from the
 * REGISTRY (src/registry-config.ts — the zero-import typed data the run-dir
 * manifest is freshness-gated against; static entries load via
 * static-extensions codegen, dynamic ones via the run-dir -e splice built
 * from the same data). `--ext-list` therefore answers the IDENTICAL JSON
 * payload the sh launcher answers — same formatExtList — derived from the
 * registry instead of ext.json manifests, so dev and dist can never drift on
 * the contract the deploy E2E asserts (loaded/loadedCount/skipped).
 *
 * Like sh's loader this is OFFLINE and read-only: entry existence is checked
 * against the bun-apps/ workspace and NO extension code is imported (that is
 * the point — evaluating static-extensions.ts pre-patch is the exact failure
 * cli.ts's intercept ladder exists to prevent), no network, no auto-install.
 *
 * Deliberately NOT listed: ad-hoc user `-e <path>` extensions (they are the
 * user's own, not part of the registry report — the sh launcher does not
 * list -e ad-hoc files either).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY, type RegistryEntry } from "./registry-config.ts";
import { formatExtList } from "./sh/ext-list.ts";
import type { LoadResult } from "./sh/ext-loader.ts";
import { HOST_API } from "./sh/host-modules.ts";
import { resolveBunAppsDir } from "./run-dir/run-context.ts";
import type { UserSuppressFlags } from "./cli-argv.ts";

export interface DevExtListOptions {
	/** Base dir registry entries resolve against (undefined → everything skips). */
	bunAppsDir: string | undefined;
	/** The registry rows to report — injected so the pure half is unit-testable. */
	registry: RegistryEntry[];
	/** Existence probe — injected (fs.exists in production, a stub in tests). */
	exists: (p: string) => boolean;
	/** User-passed suppression flags (pre-patch argv), same as the run-dir splice reads. */
	userFlags: Partial<UserSuppressFlags>;
}

/**
 * Pure registry → LoadResult projection. Registry order is preserved: static
 * entries first, then dynamic — the same order REGISTRY declares and the
 * deploy tree lays ext/<name>/ out in, so dev and dist list the same names in
 * the same order when their sets agree.
 *
 * Skip reasons mirror the loaders' own vocabulary: a disabled entry is
 * "disabled in registry" (sh: "disabled in ext.json"), a missing entry file
 * reuses the run-dir splice's "extension path not found, skipping: <path>".
 */
export function devExtListResult(opts: DevExtListOptions): LoadResult {
	const r: LoadResult = { factories: [], skillPaths: [], loaded: [], skipped: [] };
	// `-ne` mirrors cli-sh's suppressed loader: an EMPTY report, not a skipped
	// row per extension — the deploy gate reads loadedCount 0 the same way.
	if (opts.userFlags.noExtensions) return r;
	if (opts.bunAppsDir === undefined) {
		r.skipped.push({ name: "*", reason: "could not determine bun-apps/ directory" });
		return r;
	}
	for (const e of opts.registry) {
		if (!e.enabled) {
			r.skipped.push({ name: e.name, reason: "disabled in registry" });
			continue;
		}
		const entryPath = join(opts.bunAppsDir, e.package, e.entry);
		if (opts.exists(entryPath)) r.loaded.push(e.name);
		else r.skipped.push({ name: e.name, reason: `extension path not found, skipping: ${entryPath}` });
	}
	if (!opts.userFlags.noSkills) {
		for (const e of opts.registry) {
			if (!e.enabled || e.skills !== true) continue;
			const p = join(opts.bunAppsDir, e.package, "skills");
			if (opts.exists(p)) r.skillPaths.push(p);
		}
	}
	return r;
}

/**
 * The `--ext-list` / `ext list` payload for source mode. `extRoot` names the
 * dir extension entries resolve against — the deploy's ext/ tree, or the
 * bun-apps workspace here (same field, same meaning, different root).
 */
export async function formatDevExtList(userFlags: Partial<UserSuppressFlags>): Promise<string> {
	const bunAppsDir = await resolveBunAppsDir();
	return formatExtList(bunAppsDir ?? "(unresolved)", HOST_API, devExtListResult({
		bunAppsDir,
		registry: REGISTRY,
		exists: existsSync,
		userFlags,
	}));
}
