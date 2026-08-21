/**
 * remote.ts — which git remote the devops tools talk to.
 *
 * Resolution order (first wins):
 *   1. `DEVOPS_REMOTE` env — explicit override for setups where the forge
 *      remote is not named `origin` (e.g. `origin` = personal mirror,
 *      `upstream` = the real forge).
 *   2. `git config devops.remote` — per-clone setting, survives shells.
 *   3. `"origin"` — the historical default and the right answer for this
 *      repo's own clones.
 *
 * SCOPE (deliberate, 2026-08-22): only the forge-selection path
 * (src/forge/select.ts's `git remote get-url <name>`) consumes this today.
 * The recipes' `origin/main` tracking refs, `push origin`, and
 * parseRemoteBranches's `origin/` prefix still hardcode `origin` — threading
 * the name through all ~13 files is real surface (sync_default_branch alone
 * has ~48 references) and deserves its own PR with its own regression run,
 * not a tail-end sweep. This module exists so that PR has one helper to call.
 */
import type { SpawnFn } from "./spawn.js";

/** The remote name the devops tools should use (see module doc for order). */
export async function resolveRemoteName(
	spawn: SpawnFn,
	env: Record<string, string | undefined> = process.env,
): Promise<string> {
	const fromEnv = env.DEVOPS_REMOTE;
	if (fromEnv && fromEnv.trim()) return fromEnv.trim();
	const cfg = await spawn("git", ["config", "--get", "devops.remote"]);
	if (cfg.exitCode === 0 && cfg.stdout.trim()) return cfg.stdout.trim();
	return "origin";
}
