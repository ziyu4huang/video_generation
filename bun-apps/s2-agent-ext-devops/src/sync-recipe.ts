/**
 * runSync — the PURE orchestration behind the `sync_default_branch` tool. A TypeScript
 * port of scripts/sync-repo.sh (+ scripts/git-remote-main-sync.sh), agent-invoked
 * only (no shell/CLI entry point). This is ticket 02 of the "move sync into
 * devops" wayfinder map; the bash scripts are intentionally left in place for
 * ticket 03 to remove once this tool has replaced every consumer.
 *
 * Three modes (the only flags ticket 01 proved in use); `origin/<D>` below (and
 * everywhere in this file) means `<remote>/<D>` for the configured remote
 * (`remoteName` option, default `origin` — src/remote.ts):
 *   - "full"   (default): fetch → advance the DEFAULT branch (auto-detected via
 *               origin/HEAD) to origin/<D>, worktree-aware (advance it in the
 *               worktree that actually holds <D>; only check it out here when it
 *               is free), then recursively sync submodules to their remote tips.
 *               This is the "everything to latest default branch" operation.
 *   - "rebase": fetch → rebase the CURRENT branch onto origin/<D>.
 *   - "pull":   fetch → merge origin/<D> into the current branch (a REAL merge,
 *               `--no-ff` so it never fast-forwards — per spec).
 *
 * SAFETY (full-mode default-branch advance, hardening follow-up to PR #1066):
 * the DEFAULT is now `git merge --ff-only origin/<D>` — matching the original
 * bash `pull --ff-only` "never lose commits" guarantee. Since we already
 * fetched, `merge --ff-only` is preferred over `pull` (no double-fetch). If
 * local <D> has divergent/unpushed commits, the fast-forward REFUSES (git exits
 * non-zero) and the recipe ABORTS with `{ aborted: true, reason: "divergent",
 * defaultBranch, hint }` — zero mutation of <D>. The destructive
 * `git reset --hard origin/<D>` (which discards those divergent commits) is
 * reachable ONLY via an explicit `force: true` opt-in (warned in the result).
 *
 * Pre-flight (all modes): an uncommitted (dirty) tracked tree aborts every
 * MUTATING run (matches the bash `need_clean_tree` gate); unpushed commits are
 * surfaced as warnings only — in default full-mode they foreshadow the abort;
 * under force:true they precede a reset --hard that discards them. dryRun
 * computes + returns the exact git commands without spawning a single mutating
 * op — read-only queries (default-branch detection, worktree list, from/to
 * SHAs, clean/ahead checks) still run, so the dry-run plan + warnings are
 * accurate. (rebase/pull modes are UNCHANGED — they already reconcile divergence
 * via rebase/merge and never use reset --hard.)
 *
 * Every MUTATING git call funnels through the injected `SpawnFn` (the same seam
 * ci-recipe/recipe use); read-only git queries go through the injected
 * `SyncClient` (a Pick of BranchClient, extended with worktreeList/revParse/
 * isClean/aheadBehind in src/gh.ts). So the whole flow is fully testable with
 * fakes — no real git / filesystem — mirroring how runLocalCi is tested.
 *
 * Bash parity notes (deliberate deviations, ticket 02 scope):
 *   - full-mode default-branch advance now matches the bash `pull --ff-only`
 *     safety: DEFAULT is `git merge --ff-only origin/<D>` (we already fetched,
 *     so merge --ff-only over pull avoids a double-fetch), which REFUSES when
 *     local <D> has divergent/unpushed commits (never loses commits — aborts
 *     with reason "divergent" + a force hint). The destructive
 *     `git reset --hard origin/<D>` is gated behind `force:true` (opt-in;
 *     discards divergent commits, warned).
 *   - submodule sync (full only) uses `submodule update --remote --recursive`
 *     to advance every submodule to its configured remote tip, rather than the
 *     bash per-submodule `foreach checkout-default + pull` snippet (same effect
 *     via each submodule's recorded branch config); rebase/pull do not touch
 *     submodules (the spec scopes submodules to full mode).
 *   - dropped flags (no consumer per ticket 01): --remote/--branch/
 *     --no-submodules/--depth/--local/--merge/--base.
 */
import type { SpawnFn, SpawnResult } from "./spawn.js";
import type { BranchClient } from "./branch-recipe.js";
import { parseSubmoduleStatus } from "./gh.js";

export type SyncMode = "full" | "rebase" | "pull";

/** Auto-managed "hot files" preserved across a sync advance by default (stashed
 *  before, restored after) instead of aborting dirty_tree. Seeded with the
 *  hermes memory file — dirty in ~every worktree, so the default sync would
 *  otherwise ALWAYS refuse. Override via `SyncOptions.preserve`; pass `[]` to
 *  disable preserve entirely. */
export const DEFAULT_PRESERVE_PATHS = [".agents/memory/MEMORY.md"];

/** Message tagging every preserve stash entry this recipe creates — the grep
 *  target in the pop-conflict recovery hint, and the pairing marker for
 *  parkPreserve/restorePreserve (see their doc comments). */
const STASH_TAG = "sync_default_branch preserve";

/** Result of a stash+restore cycle for preserve-listed hot files. `restored` is
 *  false when the `git stash pop` conflicted (the stash is KEPT in that case;
 *  `conflict` carries the stderr so the caller can surface it). */
export interface SyncPreserved {
	/** Paths that were stashed (== the preserve-listed dirty paths at park time). */
	paths: string[];
	/** True iff `git stash pop` succeeded (working tree restored). */
	restored: boolean;
	/** Present (with the pop stderr/stdout) iff `restored` is false. */
	conflict?: string;
}

/** True iff `path` matches a preserve-list entry: an exact path, or a directory
 *  prefix (entry ending in `/`, OR an entry treated as a prefix by appending
 *  `/`). Mirrors the preserve semantics on SyncOptions. */
function isPreservable(path: string, preserve: string[]): boolean {
	return preserve.some((e) => path === e || path.startsWith(e.endsWith("/") ? e : e + "/"));
}

/** Extract the ACTUALLY conflicted paths from a failed `git stash pop`: git's
 *  stable conflict line is `CONFLICT (content): merge conflict in <path>`.
 *  Parses stderr first, stdout as fallback; deduped, order-preserved. When the
 *  output has no parsable line (other failure shapes), falls back to the full
 *  parked list — worst case the warning over-lists, never under-lists. */
function popConflictPaths(pop: SpawnResult, fallback: string[]): string[] {
	for (const out of [pop.stderr, pop.stdout]) {
		const paths = [...(`${out ?? ""}`.matchAll(/CONFLICT \(content\): merge conflict in (.+)/g) ?? [])].map((m) => m[1].trim());
		if (paths.length > 0) return [...new Set(paths)];
	}
	return fallback;
}

/**
 * The read-only git surface sync_default_branch needs. A `Pick` of BranchClient so the
 * live `createBranchClient` (full BranchClient) satisfies it, while tests inject
 * a minimal fake covering only these seven methods. NOTE: cleanliness is derived
 * from `dirtyPaths` (empty ⇒ clean) so the per-path preserve split can run on
 * the SAME query — `isClean` stays on the full BranchClient for other recipes.
 */
export type SyncClient = Pick<
	BranchClient,
	| "defaultBranch"
	| "currentBranch"
	| "worktreeList"
	| "revParse"
	| "dirtyPaths"
	| "unmergedPaths"
	| "aheadBehind"
	| "logSubjects"
>;

export interface SyncAdvanced {
	/** Worktree path where the branch was advanced. */
	worktree: string;
	/** Branch that moved (the default branch for full; the current branch for rebase/pull). */
	branch: string;
	/** SHA before the operation. */
	from: string;
	/** SHA after the operation (origin/<D> for full; post-op HEAD for rebase/pull). */
	to: string;
	/** How many commits the advance moved (rev-list count from..to). 0 under dryRun. */
	count: number;
	/** Commit subjects of the advance (newest first, capped at 15; a final
	 *  `"... and N more"` entry appears when count exceeds the cap). [] under dryRun. */
	subjects: string[];
}

/** One row of the full-mode submodule report. Evaluated in `worktree` against
 *  THAT worktree's HEAD-recorded gitlink, after `submodule update --init
 *  --recursive --remote` (so `+` typically means "advanced past the recorded
 *  gitlink by --remote", not "dirty"). */
export interface SyncSubmodule {
	/** Worktree the status was evaluated in (the caller's repoRoot, or the worktree holding the default branch). */
	worktree: string;
	/** Submodule path, repo-relative. */
	path: string;
	/** Submodule SHA reported by `git submodule status`. */
	sha: string;
	/** git status flag: `" "` matches the recorded gitlink, `"+"` differs from
	 *  it, `"-"` not initialized, `"U"` merge conflict. */
	flag: " " | "+" | "-" | "U";
	/** True iff flag is `" "` (the checked-out SHA matches the recorded gitlink). */
	matchesRecordedGitlink: boolean;
}

/** Post-run snapshot of the CALLING worktree (opts.repoRoot): what is checked
 *  out there after the sync, and how far behind origin/<D> it now is. */
export interface SyncCaller {
	/** The worktree that invoked sync_default_branch. */
	worktree: string;
	/** The branch checked out there AFTER the run; null when detached. */
	branch: string | null;
	/** True iff the calling worktree is on a detached HEAD. */
	detached: boolean;
	/** How many commits the caller's branch is behind origin/<D> AFTER the run
	 *  (null when detached). >0 pushes a behind-default warning: full mode
	 *  advances <D> only in the worktree that holds it. */
	behindDefault: number | null;
}

/** Full-mode verification snapshot: does local <D> equal origin/<D> after the
 *  advance? Always present in a completed full-mode run (dry included, where
 *  it records the drift the plan would fix). */
export interface SyncVerification {
	/** The default branch verified. */
	branch: string;
	/** Local <D> SHA after the advance ("" when unresolvable). */
	local: string;
	/** The origin/<D> SHA the advance targeted. */
	remote: string;
	/** True iff local === remote. */
	ok: boolean;
}

/**
 * Structured abort descriptor. Present (with `aborted: true`) whenever a
 * mutating mode REFUSED to run — a dirty tree, a divergent default branch (full
 * default mode), a failed checkout/rebase/merge, etc. Never thrown: every
 * refusal surfaces here so the caller (extension/tool) renders a clean block
 * outcome (mirrors runMergeRecipe's throw-free discipline).
 */
export interface SyncAbort {
	/** Always true — discriminator (present only on an aborted run). */
	aborted: true;
	/** Machine reason — one of SYNC_ABORT_REASONS: "aborted_before_start" |
	 *  "dirty_tree" | "unmerged_index" | "no_origin_ref" | "checkout_failed" |
	 *  "preserve_failed" | "divergent" | "reset_failed" | "detached_head" |
	 *  "rebase_failed" | "merge_failed". */
	reason: SyncAbortReason;
	/** Human-readable summary (what happened + immediate remediation). */
	message: string;
	/** The default branch, when relevant to the reason (divergent). */
	defaultBranch?: string;
	/** Actionable hint, when relevant (divergent → force:true). */
	hint?: string;
}

/** Every abort reason runSync can actually emit (the SyncAbort.reason union —
 *  kept in sync with the `outcome({ aborted: true, reason: … })` sites below).
 *  NOTE: reason strings are snake_case here; prepare_feature_branch separately emits
 *  hyphenated reasons ("worktree-conflict", "rebase-conflict", …) — a
 *  different union, NOT shared with this one. */
export const SYNC_ABORT_REASONS = [
	"aborted_before_start",
	"dirty_tree",
	"unmerged_index",
	"no_origin_ref",
	"checkout_failed",
	"preserve_failed",
	"divergent",
	"reset_failed",
	"detached_head",
	"rebase_failed",
	"merge_failed",
] as const;

export type SyncAbortReason = (typeof SYNC_ABORT_REASONS)[number];

export interface SyncOutcome {
	mode: SyncMode;
	dryRun: boolean;
	/** Auto-detected default branch (short name; "main" on detection failure). */
	defaultBranch: string;
	/** Branch advancements performed (empty in an aborted run; populated under dryRun). */
	advanced: SyncAdvanced[];
	/** Full-mode submodule report (parsed `git submodule status --recursive`,
	 *  per worktree evaluated). */
	submodules: SyncSubmodule[];
	/** Post-run snapshot of the calling worktree. Present once the run reached
	 *  the advance (full/rebase/pull, dry included); absent on early aborts. */
	caller?: SyncCaller;
	/** Full-mode post-advance verification snapshot. Present on every completed
	 *  full-mode run (dry included); absent on aborts + rebase/pull. */
	verification?: SyncVerification;
	/** Pre-flight issues (uncommitted, unpushed, verification drift). */
	warnings: string[];
	/** Every git command issued, rendered runnable (`git -C "<dir>" <args>`).
	 *  Always populated; the primary output under dryRun. */
	commands: string[];
	/** Set when a mutating mode refused to run (dirty tree, divergent, …). */
	aborted?: SyncAbort;
	/** Preserve-listed hot files stashed across the advance + restore result.
	 *  Present iff a stash actually ran (non-dryRun, only preserve-listed dirty). */
	preserved?: SyncPreserved;
	elapsedMs: number;
}

export interface SyncOptions {
	client: SyncClient;
	spawn: SpawnFn;
	repoRoot: string;
	mode?: SyncMode;
	dryRun?: boolean;
	/**
	 * full-mode ONLY — explicit opt-in to the destructive path. When false
	 * (default), advance the default branch with `merge --ff-only` and REFUSE if
	 * it has diverged (never loses commits). When true, use `reset --hard
	 * origin/<D>` (discards divergent commits). Ignored by rebase/pull.
	 */
	force?: boolean;
	/** Paths (exact, or dir prefix ending in `/`) whose uncommitted changes are
	 *  auto-preserved across the advance (stashed before, restored after)
	 *  instead of aborting dirty_tree. Default: DEFAULT_PRESERVE_PATHS
	 *  (`.agents/memory/MEMORY.md`). Only the listed paths are preserved; ALL
	 *  OTHER uncommitted tracked work still aborts dirty_tree. Pass `[]` to
	 *  disable preserve entirely. */
	preserve?: string[];
	/** Remote name for fetch targets + `<remote>/<D>` tracking refs (default
	 *  `origin`; resolve via src/remote.ts and pass down — never resolved here). */
	remoteName?: string;
	signal?: AbortSignal;
}

/** Render a git invocation as a runnable, human-readable shell string. */
function renderGit(dir: string, args: string[]): string {
	return `git -C "${dir}" ${args.join(" ")}`;
}

function trim(s: string): string {
	return (s ?? "").trim();
}

/**
 * Run the sync recipe. Never throws — every failure (dirty tree, missing ref,
 * divergent default branch, failed reset/rebase/merge) surfaces as a structured
 * `aborted` descriptor + `warnings` in the outcome (mirrors runMergeRecipe's
 * throw-free discipline).
 */
export async function runSync(opts: SyncOptions): Promise<SyncOutcome> {
	const t0 = Date.now();
	const mode: SyncMode = opts.mode ?? "full";
	const dry = opts.dryRun === true;
	const force = opts.force === true;
	// Preserve list: undefined ⇒ default seed (hermes MEMORY.md); [] ⇒ disabled.
	const preserve = opts.preserve === undefined ? DEFAULT_PRESERVE_PATHS : opts.preserve;
	const remote = opts.remoteName ?? "origin";
	const { client, spawn, repoRoot } = opts;
	const commands: string[] = [];
	const warnings: string[] = [];
	const advanced: SyncAdvanced[] = [];
	const submodules: SyncSubmodule[] = [];
	let preserved: SyncPreserved | undefined;
	let caller: SyncCaller | undefined;
	let verification: SyncVerification | undefined;

	/** Issue a git command: always record it (for `commands`); skip execution
	 *  entirely under dryRun (returns a canned success). */
	const git = async (dir: string, args: string[]): Promise<SpawnResult> => {
		commands.push(renderGit(dir, args));
		if (dry) return { stdout: "", stderr: "(dry-run) skipped", exitCode: 0 };
		return spawn("git", ["-C", dir, ...args]);
	};

	/** Probe the top stash entry at `dir` right after a preserve push: returns
	 *  its SHA iff its subject carries OUR tag — PROOF the push created it
	 *  (git puts a fresh stash on top, and the same-worktree index.lock makes
	 *  two interleaved stash pushes impossible, so a tagged top ⇔ ours). A
	 *  bare-gitlink pathspec creates NO entry, leaving an older FOREIGN entry
	 *  on top (untagged) → "" — the caller must not pop anything. Read-only:
	 *  raw spawn, never recorded in commands[], never run under dryRun. */
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

	/** A preserve park created by parkPreserve, restored by restorePreserve. */
	interface PreservePark {
		/** Worktree the stash lives in (the advance target, which may differ
		 *  from repoRoot in full mode). */
		dir: string;
		/** Preserve-listed dirty paths parked (stashed) there. */
		paths: string[];
		/** SHA of the tagged stash entry OUR push created — restore APPLIES this
		 *  entry by SHA (never a positional stash@{0}, which a concurrent
		 *  session may have replaced between park and restore). "" under
		 *  dryRun (no SHA is probed; the recorded plan pops positionally). */
		sha: string;
	}

	/** Park preserve-listed hot files at `dir` right before the mutating
	 *  advance. PUSH→POP PAIRING (2026-08-22 incident): `git stash push --
	 *  <pathspec>` exits 0 while creating NO entry when every pathspec is a
	 *  submodule gitlink (git cannot stash a bare gitlink) — the old code then
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

	/** Restore a parked preserve stash right after the advance (also on a
	 *  refusal — a divergent/reset abort never strands parked files in a
	 *  stash). Pairing (see parkPreserve): `stash apply <our SHA>` (git
	 *  refuses raw SHAs for pop/drop — "not a stash reference", verified on
	 *  git 2.50.1 — but ACCEPTS them for apply), then, on a clean apply,
	 *  `stash drop stash@{N}` with N re-derived from the list CONTENT so a
	 *  concurrent push between apply and drop cannot renumber us onto a
	 *  FOREIGN entry. On apply conflict: keep the stash + warn with the full
	 *  aftermath + manual recovery (the next sync will refuse on the unmerged
	 *  index — by design, via the shared unmerged pre-flight). */
	const restorePreserve = async (park: PreservePark): Promise<void> => {
		// dryRun: record the plan positionally (no SHA has been probed).
		const restore = park.sha ? ["stash", "apply", park.sha] : ["stash", "pop"];
		const apply = await git(park.dir, restore);
		if (dry) {
			if (park.sha) await git(park.dir, ["stash", "drop", "stash@{0}"]);
			return;
		}
		if (apply.exitCode !== 0) {
			preserved = { paths: park.paths, restored: false, conflict: trim(apply.stderr || apply.stdout) };
			const conflictPaths = popConflictPaths(apply, park.paths);
			warnings.push(
				`preserve restore: stash apply CONFLICTED at ${park.dir}. ` +
					`AFTERMATH: the worktree now has unmerged index entries + conflict markers in: ${conflictPaths.join(", ")}. ` +
					`The stash is KEPT (find it: git -C ${park.dir} stash list | grep '${STASH_TAG}'). ` +
					`Recover manually: resolve the markers, then ` +
					`git -C ${park.dir} add <path> && git -C ${park.dir} stash drop. ` +
					`Until resolved, the next sync will abort 'unmerged_index' by design.`,
			);
			return;
		}
		// Applied cleanly → drop the parked entry at its CURRENT (content-matched) position.
		const idx = await stashIndexOf(park.dir, park.sha);
		if (idx >= 0) {
			await git(park.dir, ["stash", "drop", `stash@{${idx}}`]);
		} else {
			warnings.push(`preserve restore: applied the parked stash (${park.sha.slice(0, 12)}), but its entry is no longer in the stash list — nothing to drop.`);
		}
		preserved = { paths: park.paths, restored: true };
	};

	/** The warn-and-skip outcome for an entry-less push: every preserve path
	 *  was an unstashable gitlink, so nothing is parked and the restore pop
	 *  MUST NOT run (a blind pop could apply an unrelated stash). */
	const emptyParkWarning = (dir: string, paths: string[]): string =>
		`preserve: 'git stash push' exited 0 but created NO stash entry at ${dir} — ` +
		`every preserve path is likely a submodule gitlink (${paths.join(", ")}), which git cannot stash. ` +
		`NOTHING was parked and the restore pop is SKIPPED (a blind 'git stash pop' could apply an ` +
		`unrelated stash from another session); the gitlink change stays in the working tree.`;

	// --- 1. Detect the default branch (read-only; runs under dryRun too). -----
	// origin/HEAD symbolic-ref → short name (main/master/develop/release/v2…).
	// Detection failure falls back to "main" (the bash hard fallback); the
	// network `git remote show origin` fallback is intentionally omitted (these
	// tools stay offline) — surfaced as a warning instead.
	let D = await client.defaultBranch();
	if (!D) {
		D = "main";
		warnings.push(`could not detect default branch via ${remote}/HEAD; falling back to 'main'.`);
	}
	const outcome = (aborted?: SyncAbort): SyncOutcome => ({
		mode,
		dryRun: dry,
		defaultBranch: D,
		advanced,
		submodules,
		caller,
		verification,
		warnings,
		commands,
		aborted,
		preserved,
		elapsedMs: Date.now() - t0,
	});

	if (opts.signal?.aborted) {
		warnings.push("aborted before start.");
		return outcome({ aborted: true, reason: "aborted_before_start", message: "aborted before start." });
	}

	/** Post-run snapshot of the CALLING worktree (read-only): what's checked out
	 *  there after the sync, and how far behind origin/<D> it now is. Warns when
	 *  the caller lags — full mode advances <D> only in the worktree that HOLDS
	 *  it, so every other worktree (possibly including the caller) stays behind. */
	const callerPostState = async (): Promise<SyncCaller> => {
		const branch = await client.currentBranch();
		const detached = !branch || branch === "HEAD";
		const behindDefault = detached ? null : (await client.aheadBehind(`${remote}/${D}`, branch)).behind;
		if ((behindDefault ?? 0) > 0) {
			warnings.push(
				`calling worktree ${repoRoot} is ${behindDefault} commit(s) behind ${D} — full mode advances the default branch only in the worktree that holds it.`,
			);
		}
		return { worktree: repoRoot, branch: detached ? null : branch, detached, behindDefault };
	};

	/** Enrich an advanced[] entry with the commits it moved: count via rev-list
	 *  (from..to), subjects via `git log --format=%s` capped at 15 (a final
	 *  `"... and N more"` entry when count exceeds the cap). dryRun: 0 / []. */
	const advancedCommits = async (from: string, to: string): Promise<{ count: number; subjects: string[] }> => {
		if (dry || !from || !to) return { count: 0, subjects: [] };
		const count = (await client.aheadBehind(from, to)).ahead;
		let subjects = await client.logSubjects(from, to, 15);
		if (count > subjects.length) subjects = [...subjects, `... and ${count - subjects.length} more`];
		return { count, subjects };
	};

	/** Run the 4-command submodule sync cycle at `dir` (fetch → update --remote →
	 *  sync → status) and fold the per-submodule status into `submodules`,
	 *  tagged with `dir`. Failures WARN + continue — never hard-abort the sync
	 *  (a broken submodule must not undo the default-branch advance that just
	 *  succeeded). Under dryRun the commands are recorded (the plan) and the
	 *  canned empty status yields no rows. */
	const submoduleOps = async (dir: string): Promise<void> => {
		const steps: Array<[string, string[]]> = [
			["fetch", ["submodule", "foreach", "--recursive", "git", "fetch", "--all", "--prune"]],
			["update", ["submodule", "update", "--init", "--recursive", "--remote"]],
			["sync", ["submodule", "sync", "--recursive"]],
		];
		for (const [label, args] of steps) {
			const r = await git(dir, args);
			if (r.exitCode !== 0) warnings.push(`submodule ${label} failed at ${dir}: ${trim(r.stderr || r.stdout)}`);
		}
		const status = await git(dir, ["submodule", "status", "--recursive"]);
		if (status.exitCode !== 0) {
			warnings.push(`submodule status failed at ${dir}: ${trim(status.stderr || status.stdout)}`);
			return;
		}
		for (const s of parseSubmoduleStatus(status.stdout)) {
			submodules.push({ worktree: dir, path: s.path, sha: s.sha, flag: s.flag, matchesRecordedGitlink: s.flag === " " });
		}
	};

	/** Unmerged (conflicted) index entries: a previous stash pop / merge left the
	 *  worktree mid-conflict. `stash push` against such an index fails with a
	 *  cryptic "could not write index" (observed 2026-08-19/20 on both worktrees
	 *  via MEMORY.md) — refuse EARLY with the fix instead. Shared by EVERY mode
	 *  (full + rebase/pull): warns ALWAYS (dryRun keeps planning); returns the
	 *  `unmerged_index` abort descriptor only when mutating. */
	const unmergedAbort = async (target: string): Promise<SyncAbort | undefined> => {
		const unmerged = await client.unmergedPaths(target);
		if (unmerged.length === 0) return undefined;
		const howTo = [
			`resolve each file then: git -C ${target} add <path>`,
			`or abort the leftover op: git -C ${target} merge --abort (or rebase --abort)`,
			`or finish the interrupted stash pop: git -C ${target} stash pop`,
		].join("; ");
		const msg =
			`unmerged index entries at ${target}: ${unmerged.join(", ")} — ` +
			`a conflicted stash pop or interrupted merge left the tree mid-conflict. Fix first: ${howTo}.`;
		warnings.push(msg);
		if (dry) return undefined;
		return { aborted: true, reason: "unmerged_index", message: msg };
	};

	const current = await client.currentBranch();

	// --- 2. Pre-flight: unpushed-commit warnings (read-only; best-effort). ----
	// A missing upstream (origin/<branch> not fetched) → aheadBehind returns 0.
	if (current && current !== "HEAD") {
		const ab = await client.aheadBehind(`${remote}/${current}`, current);
		if (ab.ahead > 0) warnings.push(`${current} is ${ab.ahead} commit(s) ahead of ${remote}/${current} (unpushed).`);
	}
	const dab = await client.aheadBehind(`${remote}/${D}`, D);
	if (dab.ahead > 0) {
		// In default full-mode these commits block the fast-forward (the recipe
		// aborts below); under force:true they're discarded by reset --hard.
		warnings.push(
			`default branch '${D}' is ${dab.ahead} commit(s) ahead of ${remote}/${D} (unpushed) — full mode's fast-forward will refuse them; force:true discards them via reset --hard.`,
		);
	}

	// --- FULL ----------------------------------------------------------------
	if (mode === "full") {
		// 3. Worktree-aware: where does <D> currently live? Advance it THERE
		//    (this worktree stays on its branch) unless <D> is free, in which
		//    case check it out here first. Mirrors the bash `worktree_for_branch`.
		const worktrees = await client.worktreeList();
		const defaultWt = worktrees.find((w) => w.branch === D)?.worktree;
		const needCheckout = !defaultWt; // <D> checked out nowhere → claim it here
		const advanceTarget = defaultWt ?? repoRoot;

		// Pre-flight (per-path preserve split): separate dirty paths into
		// preservable (auto-managed hot files) vs real (everything else). Real
		// dirty → STILL abort dirty_tree (genuine uncommitted work — safety gate
		// intact). Only-preservable dirty → stash those paths before the advance,
		// restore after (never lose them). Warn always; abort only when mutating.
		const dirty = await client.dirtyPaths(advanceTarget);
		const preservable = dirty.filter((p) => isPreservable(p, preserve));
		const real = dirty.filter((p) => !isPreservable(p, preserve));
		if (dirty.length > 0) {
			warnings.push(
				`worktree '${advanceTarget}' has ${dirty.length} uncommitted tracked change(s) (${real.length} real, ${preservable.length} preserve-listed).`,
			);
		}
		if (!dry && real.length > 0) {
			return outcome({
				aborted: true,
				reason: "dirty_tree",
				message: `dirty tree at ${advanceTarget}; ${real.length} uncommitted path(s) outside the preserve list (stash or commit first).`,
			});
		}

		// Unmerged (conflicted) index entries: refuse EARLY, before the fetch /
		// preserve stash push (shared helper — see its doc comment).
		const unmerged = await unmergedAbort(advanceTarget);
		if (unmerged) return outcome(unmerged);

		// 4. Fetch (mutating; skipped under dryRun).
		await git(repoRoot, ["fetch", remote]);

		// 5. Resolve the target SHA (<remote>/<D> must exist post-fetch).
		const to = await client.revParse(`${remote}/${D}`);
		if (!to) {
			warnings.push(`cannot resolve ${remote}/${D} — is remote '${remote}' fetched?`);
			return outcome({ aborted: true, reason: "no_origin_ref", message: `cannot resolve ${remote}/${D}` });
		}

		// 6. If <D> was free, check it out here first; then advance it.
		if (needCheckout) {
			const co = await git(repoRoot, ["checkout", D]);
			if (co.exitCode !== 0) {
				warnings.push(`git checkout ${D} failed: ${trim(co.stderr || co.stdout)}`);
				return outcome({ aborted: true, reason: "checkout_failed", message: `checkout ${D} failed` });
			}
		}
		const from = (await client.revParse(D)) ?? "";

		// PARK preserve-listed hot files RIGHT BEFORE the mutating advance (so
		// read-only detection aborts above never leave them stashed). Recorded in
		// commands[] under dryRun too; the stash actually runs only when mutating.
		// Shared park/restore helpers enforce the push→pop pairing (see
		// parkPreserve) — the restore pops ONLY the entry this push created.
		let park: PreservePark | undefined;
		if (preservable.length > 0) {
			const p = await parkPreserve(advanceTarget, preservable);
			if (p.aborted) return outcome({ aborted: true, reason: "preserve_failed", message: p.aborted });
			if (p.empty) warnings.push(emptyParkWarning(advanceTarget, preservable));
			park = p.park;
		}

		// The advance — the only mutating op that needs a clean tree.
		let advanceAborted: SyncAbort | undefined;
		if (force) {
			// DESTRUCTIVE (opt-in): reset --hard <remote>/<D> — discards any
			// divergent/unpushed commits on <D>. Warned in the result.
			const reset = await git(advanceTarget, ["reset", "--hard", `${remote}/${D}`]);
			if (reset.exitCode !== 0) {
				warnings.push(`reset --hard failed: ${trim(reset.stderr || reset.stdout)}`);
				advanceAborted = { aborted: true, reason: "reset_failed", message: `reset --hard ${remote}/${D} failed` };
			} else {
				warnings.push(
					`force:true — used 'git reset --hard ${remote}/${D}', which discards any divergent/unpushed commits on '${D}'.`,
				);
			}
		} else {
			// SAFE DEFAULT: merge --ff-only. We already fetched, so this avoids
			// pull's double-fetch. git REFUSES (exit non-zero) when local <D>
			// has divergent/unpushed commits — so the fast-forward can NEVER
			// lose a commit. On refusal, abort (after restoring the stash below).
			const ff = await git(advanceTarget, ["merge", "--ff-only", `${remote}/${D}`]);
			if (ff.exitCode !== 0) {
				advanceAborted = {
					aborted: true,
					reason: "divergent",
					defaultBranch: D,
					message: `default branch '${D}' has commits not on ${remote}/${D}; refusing to fast-forward.`,
					hint: `default branch '${D}' has commits not on ${remote}/${D}; refusing to fast-forward. Re-run with force:true to reset --hard (discards those local commits).`,
				};
			}
		}

		// POP RIGHT AFTER the advance — restore the parked hot files whether the
		// advance succeeded OR refused (so a divergent/reset abort never strands
		// them in a stash). Only runs when the park actually created an entry.
		if (park) await restorePreserve(park);

		// Surface a refusal now — AFTER the stash was restored.
		if (advanceAborted) return outcome(advanceAborted);
		const { count, subjects } = await advancedCommits(from, to);
		advanced.push({ worktree: advanceTarget, branch: D, from, to, count, subjects });

		// 8. Verification snapshot (ALWAYS present in full mode — even under
		//    dryRun, where it records the drift the plan would fix): does local
		//    <D> equal the origin/<D> we targeted? Mismatch warns (never aborts —
		//    the bash verify_default_at_latest guard, loud not fatal).
		const localD = (await client.revParse(D)) ?? "";
		verification = { branch: D, local: localD, remote: to, ok: localD === to };
		if (!dry && localD && !verification.ok) {
			warnings.push(`verification: local '${D}' (${localD.slice(0, 12)}) != ${remote}/${D} (${to.slice(0, 12)}).`);
		}

		// 9. Recursive submodule sync (full only): fetch each, advance every
		//    submodule to its configured remote tip, reconcile paths, then report —
		//    in the CALLER's worktree AND (when <D> was advanced in a DIFFERENT
		//    worktree) there too, so both trees' submodules sit at the remote tips.
		//    Per-worktree failures warn; the sync never hard-aborts.
		await submoduleOps(repoRoot);
		if (advanceTarget !== repoRoot) await submoduleOps(advanceTarget);

		// Post-run caller snapshot (behind-default warning when the caller lags).
		caller = await callerPostState();
		return outcome();
	}

	// --- REBASE / PULL (the current branch with origin/<D>) ------------------
	if (!current || current === "HEAD") {
		warnings.push("detached HEAD — cannot rebase/merge a detached worktree.");
		return outcome({ aborted: true, reason: "detached_head", message: "detached HEAD; cannot advance a detached worktree" });
	}
	// Pre-flight (per-path preserve split): see full-mode for the rationale.
	const dirty = await client.dirtyPaths(repoRoot);
	const preservable = dirty.filter((p) => isPreservable(p, preserve));
	const real = dirty.filter((p) => !isPreservable(p, preserve));
	if (dirty.length > 0) {
		warnings.push(
			`worktree '${repoRoot}' has ${dirty.length} uncommitted tracked change(s) (${real.length} real, ${preservable.length} preserve-listed).`,
		);
	}
	if (!dry && real.length > 0) {
		return outcome({
			aborted: true,
			reason: "dirty_tree",
			message: `dirty tree at ${repoRoot}; ${real.length} uncommitted path(s) outside the preserve list (stash or commit first).`,
		});
	}

	// Unmerged (conflicted) index entries: refuse EARLY, before the fetch /
	// preserve stash push (shared helper — same gate as full mode; this branch
	// parks preserve paths via `stash push` too, and it dies the same cryptic
	// way against a conflicted index).
	const unmerged = await unmergedAbort(repoRoot);
	if (unmerged) return outcome(unmerged);

	await git(repoRoot, ["fetch", remote]);

	const remoteTip = await client.revParse(`${remote}/${D}`);
	if (!remoteTip) {
		warnings.push(`cannot resolve ${remote}/${D} — is remote '${remote}' fetched?`);
		return outcome({ aborted: true, reason: "no_origin_ref", message: `cannot resolve ${remote}/${D}` });
	}
	const from = (await client.revParse("HEAD")) ?? "";

	// PARK preserve-listed hot files RIGHT BEFORE the mutating rebase/merge.
	// Same park/restore pairing as full mode (see parkPreserve).
	let park: PreservePark | undefined;
	if (preservable.length > 0) {
		const p = await parkPreserve(repoRoot, preservable);
		if (p.aborted) return outcome({ aborted: true, reason: "preserve_failed", message: p.aborted });
		if (p.empty) warnings.push(emptyParkWarning(repoRoot, preservable));
		park = p.park;
	}

	// The advance — the only mutating op that needs a clean tree.
	let advanceAborted: SyncAbort | undefined;
	if (mode === "rebase") {
		const r = await git(repoRoot, ["rebase", `${remote}/${D}`]);
		if (r.exitCode !== 0) {
			warnings.push(`rebase failed: ${trim(r.stderr || r.stdout)}`);
			advanceAborted = { aborted: true, reason: "rebase_failed", message: `rebase onto ${remote}/${D} failed (resolve conflicts, then re-run).` };
		}
	} else {
		// pull → real merge, never fast-forward (per spec: "merge instead of ff").
		const r = await git(repoRoot, ["merge", "--no-edit", "--no-ff", `${remote}/${D}`]);
		if (r.exitCode !== 0) {
			warnings.push(`merge failed: ${trim(r.stderr || r.stdout)}`);
			advanceAborted = { aborted: true, reason: "merge_failed", message: `merge ${remote}/${D} failed (resolve conflicts, then re-run).` };
		}
	}

	// POP RIGHT AFTER the advance — restore parked hot files even on a refusal.
	// Only runs when the park actually created an entry (pairing; full-mode
	// message shape applies — see restorePreserve).
	if (park) await restorePreserve(park);

	if (advanceAborted) return outcome(advanceAborted);
	const after = (await client.revParse("HEAD")) ?? "";
	const { count, subjects } = await advancedCommits(from, after);
	advanced.push({ worktree: repoRoot, branch: current, from, to: after, count, subjects });
	// Post-run caller snapshot (behind-default warning when the caller lags).
	caller = await callerPostState();
	return outcome();
}
