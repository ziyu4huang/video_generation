/**
 * preserve — the shared park/restore mechanism for auto-managed "hot files"
 * (`.agents/memory/MEMORY.md`, written by hermes in ~every live-session
 * worktree) that must not abort a dirty-tree gate but cannot survive a
 * tree-mutating step in place.
 *
 * Consumers: sync-recipe (the advance/rebase that moves HEAD) and
 * merge-pr-after-ci-cli (the branch-cleanup detach onto the merge commit).
 * Both hit the same wall: hermes leaves MEMORY.md dirty in a live session,
 * so a fail-closed dirty-tree gate refuses the run — and the operator had to
 * `git stash push -- <path>` + `pop` the file by hand around every invocation
 * (measured twice in one session on 2026-08-30 before the merge CLI got
 * this). One implementation, two consumers, so the pairing semantics cannot
 * drift between the flows.
 *
 * Semantics:
 *   - parkPreserve: `git stash push -m <tag> -- <paths>`, then PROVES the
 *     push created an entry (the top stash entry must carry our tag; git puts
 *     a fresh stash on top). A push that exits 0 but creates no entry (every
 *     pathspec a bare submodule gitlink — git cannot stash one) parks NOTHING
 *     and the restore must not pop anything: a blind `stash pop` could apply
 *     ANOTHER session's day-old stash as a phantom conflict (2026-08-22
 *     incident).
 *   - restorePreserve: `git stash apply <parked SHA>` (git refuses raw SHAs
 *     for pop/drop — "not a stash reference", verified on git 2.50.1 — but
 *     ACCEPTS them for apply), then `stash drop stash@{N}` with N re-derived
 *     from the list CONTENT at drop time (positions renumber under concurrent
 *     pushes). On apply conflict: the stash is KEPT and the warning carries
 *     the full aftermath + manual recovery — never a lost file.
 */
import type { SpawnFn, SpawnResult } from "./spawn.js";

/** Auto-managed "hot files" preserved across a mutating devops run (stashed
 *  before, restored after) instead of aborting dirty_tree. Seeded with the
 *  hermes memory file — dirty in ~every worktree, so a fail-closed gate would
 *  otherwise ALWAYS refuse. Consumers may override their own list; pass `[]`
 *  to disable preserve entirely. */
export const DEFAULT_PRESERVE_PATHS = [".agents/memory/MEMORY.md"];

/** Message tagging every preserve stash entry this module creates — the grep
 *  target in the apply-conflict recovery hint, and the pairing marker for
 *  parkPreserve/restorePreserve (see their doc comments). Load-bearing for
 *  pairing, not cosmetic: keep the string stable. */
export const STASH_TAG = "sync_default_branch preserve";

/** Result of a stash+restore cycle for preserve-listed hot files. `restored`
 *  is false when the `git stash apply` conflicted (the stash is KEPT in that
 *  case; `conflict` carries the stderr so the caller can surface it). */
export interface PreserveOutcome {
	/** Paths that were stashed (== the preserve-listed dirty paths at park time). */
	paths: string[];
	/** True iff the restore `git stash apply` succeeded (working tree restored). */
	restored: boolean;
	/** Present (with the apply stderr/stdout) iff `restored` is false. */
	conflict?: string;
}

/** True iff `path` matches a preserve-list entry: an exact path, or a directory
 *  prefix (entry ending in `/`, OR an entry treated as a prefix by appending
 *  `/`). */
export function isPreservable(path: string, preserve: string[]): boolean {
	return preserve.some((e) => path === e || path.startsWith(e.endsWith("/") ? e : e + "/"));
}

/** Extract the ACTUALLY conflicted paths from a failed `git stash apply`/pop:
 *  git's stable conflict line is `CONFLICT (content): Merge conflict in <path>`
 *  (capital "Merge" — git's merge machinery never prints the lowercase shape;
 *  a parser pinned to lowercase silently never matched real output and always
 *  fell back to over-listing, measured in PR #2168 review 2026-08-30).
 *  Parses stderr first, stdout as fallback; deduped, order-preserved. When the
 *  output has no parsable line (other failure shapes), falls back to the full
 *  parked list — worst case the warning over-lists, never under-lists. */
function popConflictPaths(pop: SpawnResult, fallback: string[]): string[] {
	for (const out of [pop.stderr, pop.stdout]) {
		const paths = [...(`${out ?? ""}`.matchAll(/CONFLICT \(content\): [Mm]erge conflict in (.+)/g) ?? [])].map((m) => m[1].trim());
		if (paths.length > 0) return [...new Set(paths)];
	}
	return fallback;
}

function trim(s: string): string {
	return s.trim();
}

/** A preserve park created by parkPreserve, restored by restorePreserve. */
export interface PreservePark {
	/** Worktree the stash lives in. */
	dir: string;
	/** Preserve-listed dirty paths parked (stashed) there. */
	paths: string[];
	/** SHA of the tagged stash entry OUR push created — restore APPLIES this
	 *  entry by SHA (never a positional stash@{0}, which a concurrent session
	 *  may have replaced between park and restore). "" under dryRun (no SHA is
	 *  probed; the recorded plan pops positionally). */
	sha: string;
}

/** The record + dry-run-skip git seam the caller owns — e.g. sync's `git`
 *  helper (push into `commands[]`, return a canned success under dryRun). */
export type PreserveGit = (dir: string, args: string[]) => Promise<SpawnResult>;

/** The shared park/restore pair plus the empty-park warning text. */
export function createPreserveStash(opts: { git: PreserveGit; spawn: SpawnFn; dry: boolean }) {
	const { git, spawn, dry } = opts;

	/** Probe the top stash entry at `dir` right after a preserve push: returns
	 *  its SHA iff its subject carries OUR tag — PROOF the push created it
	 *  (git puts a fresh stash on top, and the same-worktree index.lock makes
	 *  two interleaved stash pushes impossible, so a tagged top ⇔ ours). A
	 *  bare-gitlink pathspec creates NO entry, leaving an older FOREIGN entry
	 *  on top (untagged) → "" — the caller must not pop anything. Read-only:
	 *  raw spawn (never routed through the recording `git` seam), never run
	 *  under dryRun. */
	const taggedStashTop = async (dir: string): Promise<string> => {
		if (dry) return "";
		const r = await spawn("git", ["-C", dir, "stash", "list", "--format=%H %gs", "-n", "1"]);
		if (r.exitCode !== 0) return "";
		const m = /^([0-9a-f]{7,40}) (.+)$/.exec(trim((r.stdout ?? "").split("\n")[0] ?? ""));
		return m && m[2].includes(STASH_TAG) ? m[1] : "";
	};

	/** Resolve `sha`'s CURRENT position in the stash list at `dir` (−1 when
	 *  absent). git accepts only positional stash@{N} for drop — but positions
	 *  renumber under concurrent pushes, so the index is re-derived from
	 *  CONTENT at drop time (the parked SHA itself is immutable). */
	const stashIndexOf = async (dir: string, sha: string): Promise<number> => {
		if (dry) return -1;
		const r = await spawn("git", ["-C", dir, "stash", "list", "--format=%H"]);
		if (r.exitCode !== 0) return -1;
		return (r.stdout ?? "").split("\n").map((l) => l.trim()).indexOf(sha);
	};

	/** Park preserve-listed hot files at `dir` right before the mutating step.
	 *  PUSH→POP PAIRING (2026-08-22 incident): `git stash push -- <pathspec>`
	 *  exits 0 while creating NO entry when every pathspec is a submodule
	 *  gitlink (git cannot stash a bare gitlink) — the old code then
	 *  blind-popped stash@{0}, applying ANOTHER session's day-old stash onto
	 *  the tree as a phantom conflict. The park therefore verifies its push
	 *  created the entry (taggedStashTop: the top entry must carry our tag)
	 *  and records that entry's SHA for a paired restore. Returns {aborted}
	 *  with the failure message on a failed push; {empty} when the push
	 *  created no provable entry (nothing parked, nothing to pop — the caller
	 *  warns); or {park} for restorePreserve. */
	const parkPreserve = async (
		dir: string,
		paths: string[],
	): Promise<{ aborted?: string; empty?: boolean; park?: PreservePark }> => {
		const push = await git(dir, ["stash", "push", "-m", STASH_TAG, "--", ...paths]);
		if (!dry && push.exitCode !== 0) {
			return { aborted: `stash push of preserve paths failed: ${trim(push.stderr || push.stdout)}` };
		}
		if (dry) return { park: { dir, paths, sha: "" } };
		const sha = await taggedStashTop(dir);
		if (!sha) return { empty: true };
		return { park: { dir, paths, sha } };
	};

	/** Restore a parked preserve stash right after the mutating step (also on a
	 *  refusal — an aborted advance never strands parked files in a stash).
	 *  Pairing (see parkPreserve): `git stash apply <our SHA>`, then, on a
	 *  clean apply, `stash drop stash@{N}` with N re-derived from the list
	 *  CONTENT so a concurrent push between apply and drop cannot renumber us
	 *  onto a FOREIGN entry. On apply conflict: keep the stash + warn with the
	 *  full aftermath + manual recovery (until resolved, the conflicted index
	 *  fails every later preserve stash push, so the next mutating run refuses
	 *  by design). Returns the PreserveOutcome (iff a restore was attempted)
	 *  plus warnings for the caller to surface. */
	const restorePreserve = async (park: PreservePark): Promise<{ outcome?: PreserveOutcome; warnings: string[] }> => {
		const warnings: string[] = [];
		// dryRun: record the plan positionally (no SHA has been probed).
		const restore = park.sha ? ["stash", "apply", park.sha] : ["stash", "pop"];
		const apply = await git(park.dir, restore);
		if (dry) {
			if (park.sha) await git(park.dir, ["stash", "drop", "stash@{0}"]);
			return { warnings };
		}
		if (apply.exitCode !== 0) {
			const conflictPaths = popConflictPaths(apply, park.paths);
			warnings.push(
				`preserve restore: stash apply CONFLICTED at ${park.dir}. ` +
					`AFTERMATH: the worktree now has unmerged index entries + conflict markers in: ${conflictPaths.join(", ")}. ` +
					`The stash is KEPT (find it: git -C ${park.dir} stash list | grep '${STASH_TAG}'). ` +
					`Recover manually: resolve the markers, then ` +
					`git -C ${park.dir} add <path> && git -C ${park.dir} stash drop. ` +
					`Until resolved, the next mutating run will refuse on the conflicted index by design.`,
			);
			return { outcome: { paths: park.paths, restored: false, conflict: trim(apply.stderr || apply.stdout) }, warnings };
		}
		// Applied cleanly → drop the parked entry at its CURRENT (content-matched) position.
		const idx = await stashIndexOf(park.dir, park.sha);
		if (idx >= 0) {
			await git(park.dir, ["stash", "drop", `stash@{${idx}}`]);
		} else {
			warnings.push(`preserve restore: applied the parked stash (${park.sha.slice(0, 12)}), but its entry is no longer in the stash list — nothing to drop.`);
		}
		return { outcome: { paths: park.paths, restored: true }, warnings };
	};

	/** The warn-and-skip outcome for an entry-less push: every preserve path
	 *  was an unstashable gitlink, so nothing is parked and the restore pop
	 *  MUST NOT run (a blind pop could apply an unrelated stash). */
	const emptyParkWarning = (dir: string, paths: string[]): string =>
		`preserve: 'git stash push' exited 0 but created NO stash entry at ${dir} — ` +
		`every preserve path is likely a submodule gitlink (${paths.join(", ")}), which git cannot stash. ` +
		`NOTHING was parked and the restore pop is SKIPPED (a blind 'git stash pop' could apply an ` +
		`unrelated stash from another session); the gitlink change stays in the working tree.`;

	return { parkPreserve, restorePreserve, emptyParkWarning };
}
