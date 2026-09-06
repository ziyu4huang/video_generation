/**
 * workspace-links.ts — repair the bun isolated-linker's workspace symlinks.
 *
 * WHY THIS EXISTS (found live twice on 2026-09-06): `bun install` runs (full
 * installs, e.g. the s2-agent.sh boot self-heal or CI gate materialization)
 * rewrite `bun-apps/node_modules/@repo/<pkg>` links with a target shaped for
 * a ROOT-level node_modules (`../../bun-apps/<pkg>`), which from the actual
 * location resolves to `bun-apps/bun-apps/<pkg>` — dangling. Steps that stat
 * through the links (the deploy vendor step) then die with ENOENT even
 * though `bun install` itself reports "no changes" (it resolves workspaces
 * through its own mechanism, not these links).
 *
 * The repair rewrites every dangling @repo link to `../../<pkg>` — correct
 * from `bun-apps/node_modules/@repo/` — and leaves resolving links alone.
 * Deterministic, no-op when everything is healthy.
 */
import { readdirSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface LinkRepair {
	/** Link names rewritten (were dangling). */
	repaired: string[];
	/** Link names that already resolved — untouched. */
	healthy: number;
}

/** Scan `<dir>/@repo/*` and re-point every dangling link at `../../<name>`. */
export function repairWorkspaceLinks(bunAppsDir: string, scope = "@repo"): LinkRepair {
	const dir = join(bunAppsDir, "node_modules", scope);
	const out: LinkRepair = { repaired: [], healthy: 0 };
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return out; // no link dir yet — nothing to repair
	}
	for (const name of names) {
		const link = join(dir, name);
		let stat: import("node:fs").Stats;
		try {
			stat = statSync(link); // FOLLOWS the link — ENOENT here means dangling
		} catch {
			try {
				unlinkSync(link);
				symlinkSync(join("..", "..", name), link);
				out.repaired.push(name);
			} catch {
				// Unrepairable (permissions?) — leave it; the caller's own error
				// will name the path if it matters downstream.
			}
			continue;
		}
		if (stat.isDirectory() || stat.isFile()) out.healthy += 1;
	}
	return out;
}
