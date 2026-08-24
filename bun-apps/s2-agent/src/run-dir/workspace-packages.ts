/**
 * workspace-packages.ts — the ONE walk of the bun-apps/ workspace members.
 *
 * Shared by src/run-dir/check-deps.ts (labels missing deps workspace-vs-npm in
 * the pre-flight self-heal message) and src/patches/ensure-extension-deps.ts
 * (symlinks every @repo/* member at repo-root node_modules) — previously two
 * hand-rolled copies of the same readdir/package.json walk.
 *
 * Deliberately dependency-free (node:fs + node:path only): patches/ imports it
 * at boot, so it must not pull run-context.ts (mode detection) or manifest.json.
 * Read-only and best-effort: a missing/unreadable package.json simply omits
 * that directory from the result.
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";

export interface WorkspacePackage {
	/** Sub-directory name under bunAppsDir (e.g. "s2-agent-ext-obsidian"). */
	dir: string;
	/** That package's package.json `name` (guaranteed a string). */
	name: string;
}

/**
 * Workspace packages published under <bunAppsDir>/* (each sub-dir's
 * package.json `name`). Cheap (≤ ~20 dirs), read-only, best-effort — callers
 * filter by name (e.g. `@repo/` prefix) at the use site.
 */
export function workspacePackages(bunAppsDir: string): WorkspacePackage[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(bunAppsDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: WorkspacePackage[] = [];
	for (const ent of entries) {
		if (!ent.isDirectory()) continue;
		const pj = join(bunAppsDir, ent.name, "package.json");
		if (!existsSync(pj)) continue;
		try {
			const name = JSON.parse(readFileSync(pj, "utf8")).name;
			if (typeof name === "string") out.push({ dir: ent.name, name });
		} catch {
			// Unreadable package.json — skip; both callers are best-effort.
		}
	}
	return out;
}
