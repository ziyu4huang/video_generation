/**
 * git.ts — the one git-spawn leaf for cli commands (effort
 * 2026-08-25-s2-agent-simplify-round2 ticket 05).
 *
 * `pipeline-gate.changedFilesSinceBase` and `agent-trends.listWorktrees` each
 * carried a private Bun.spawnSync(["git", …]) + exitCode→stdout-lines block.
 * One helper now; failure POLICY stays at the call sites — null means the spawn
 * failed (non-zero exit, empty stdout, or a throw): callers that treat failure
 * as "empty" do `?? []`, callers that must distinguish "git error" from "no
 * changes" (pipeline-gate's gate rows) check for null.
 *
 * LEAF: node builtins + the Bun global only — import-light by construction
 * (round-1 D6); lives in the cli namespace so it never enters the cli-sh bundle.
 */

/** Run `git <args…>` in `cwd`; stdout lines (empties dropped), or null on ANY failure. */
export function gitLines(cwd: string, args: string[]): string[] | null {
	try {
		const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
		if (r.exitCode !== 0 || !r.stdout) return null;
		return r.stdout.toString().split("\n").filter(Boolean);
	} catch {
		return null;
	}
}
