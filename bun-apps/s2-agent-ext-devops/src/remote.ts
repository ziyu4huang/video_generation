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
 * Consumed by forge selection (src/forge/select.ts — `SelectedForge.remoteName`)
 * AND threaded through `createBranchClient(spawn, remoteName)` + every
 * recipe's `remoteName` option (default `origin`), so `git fetch/push` args
 * and `<remote>/<branch>` tracking refs follow the configured remote
 * everywhere. Callers resolve ONCE per invocation and pass the name down;
 * recipes never resolve it themselves.
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
