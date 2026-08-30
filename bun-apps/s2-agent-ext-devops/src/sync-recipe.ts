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
 * DETACHED-HEAD HARDENING (rebase/pull only — `branch` option): session
 * worktrees in this repo routinely sit on a detached HEAD (post-merge detach,
 * fresh agent worktree), where rebase/pull used to hard-abort `detached_head`.
 * Pass `branch: "<name>"` (or `"auto"`, derived from the worktree folder
 * suffix — `video_generation__memory` → `memory`) to instead create the branch
 * at the CURRENT HEAD (preserving any commits already on the detached HEAD)
 * and proceed with the rebase/pull. Guards, all pre-mutation: the resolved
 * name must be non-empty and NOT the default branch; a branch of that name
 * already existing at a DIFFERENT commit aborts `branch_exists` (existing at
 * the exact HEAD is ATTACHED via plain `git checkout`, not recreated); a
 * branch checked out in another worktree aborts `worktree_conflict` (git
 * checkout would fatal). Without `branch`, the historical abort stands.
 *
 * HANDS-ON MODE (the SOP one-shot prelude — hardens the self-reflect-next-goal
 * EXECUTE step 1 into a single deterministic call): `mode: "hands-on"`
 * guarantees, after ONE invocation, that BOTH (1) the default branch <D>
 * equals <remote>/<D> and (2) the CALLING worktree sits at that tip. It composes
 * the two existing tested paths — phase A runs the full-mode advance verbatim
 * (worktree-aware ff-only, force opt-in, preserve hot files, checkout <D> here
 * when it is free, submodules in caller + advance target), then phase B
 * reconciles the CALLER when it still lags (only possible when <D> advanced in
 * a DIFFERENT worktree): the current branch is rebased onto <remote>/<D>, or a
 * detached HEAD is recovered via `branch` (default "auto") — branch at HEAD,
 * then rebase. The outcome carries a `handsOn` verdict: `callerAtTip` is true
 * iff HEAD is 0 commits behind <remote>/<D> after the run. A phase-B abort
 * keeps phase A's advance in the merged outcome (the default branch IS synced;
 * only the caller reconcile failed). This replaces the old 3-branch prose
 * recipe (rebase → detached abort → raw fetch/count → prepare-feature-branch).
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
import {
	createPreserveStash,
	DEFAULT_PRESERVE_PATHS,
	isPreservable,
	type PreserveOutcome as SyncPreserved,
	type PreservePark,
} from "./preserve.js";

// Preserve machinery lives in src/preserve.ts (shared with merge-pr-after-ci-cli
// so the two flows cannot drift). Re-exported here for import stability —
// sync-default-branch-cli imports DEFAULT_PRESERVE_PATHS from this module.
export { DEFAULT_PRESERVE_PATHS } from "./preserve.js";
export type { PreserveOutcome as SyncPreserved } from "./preserve.js";

export type SyncMode = "full" | "rebase" | "pull" | "hands-on";

/**
 * Per-command wall-clock cap for every git call a sync issues (fetch, stash,
 * ff-only advance, submodule update …), injected via withDefaultTimeout at the
 * CLI/tool wiring seams. Motivated by the 2026-08-24 11-minute
 * `sync-default-branch` stall — which the RCA later attributed to a WRONG
 * INVOCATION (the s2-agent TUI wrapper treats an unknown bare token as a
 * prompt and starts a model-waiting agent session), not to a hung fetch — so
 * this is defense-in-depth for the hazard class, not the fix for that incident:
 * unbounded network spawns are exactly what ci-recipe already caps everywhere
 * else. 5 minutes is generous for any single command (a healthy fetch lands in
 * seconds) while keeping the tool's worst case finite and self-reporting.
 *
 * Lives HERE — not in sync-default-branch-cli.ts — because extensions/devops.ts
 * must import it too, and importing the CLI module from the extension drags its
 * `import.meta.main` top-level-await tail into the CJS ext bundle (deploy Gate
 * 5 build failure; the same class as the pi-agent-sh cjs traps).
 */
export const SYNC_DEFAULT_TIMEOUT_MS = 300_000;

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
	 *  "branch_name_invalid" | "branch_exists" | "worktree_conflict" |
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
	"branch_name_invalid",
	"branch_exists",
	"worktree_conflict",
	"rebase_failed",
	"merge_failed",
] as const;

export type SyncAbortReason = (typeof SYNC_ABORT_REASONS)[number];

/** Hands-on verdict — the SOP prelude's checkable outcome. Present (on every
 *  hands-on run, dry included) exactly when mode === "hands-on". */
export interface SyncHandsOn {
	/** What the mode did to bring the CALLING worktree to the tip:
	 *  - "advanced-default-here"  — the caller holds <D>; phase A advanced it here.
	 *  - "claimed-default-here"   — <D> was free; phase A checked it out in the caller.
	 *  - "rebased-current-branch" — <D> advanced elsewhere; caller's branch rebased onto the tip.
	 *  - "attached-and-rebased"   — <D> advanced elsewhere; detached caller recovered via `branch` + rebased.
	 *  - "already-at-tip"         — <D> advanced elsewhere; caller was already at the tip (phase B skipped).
	 *  - "reconcile-aborted"      — phase B aborted (the default branch IS advanced; caller is not).
	 *  - "none"                   — phase A aborted before anything moved. */
	callerAction:
		| "advanced-default-here"
		| "claimed-default-here"
		| "rebased-current-branch"
		| "attached-and-rebased"
		| "already-at-tip"
		| "reconcile-aborted"
		| "none";
	/** True iff HEAD is 0 commits behind <remote>/<D> after the run (false on any
	 *  abort). Under dryRun this PROJECTS the plan against the current refs —
	 *  nothing was fetched, so the tip the plan reconciles onto may itself move
	 *  when the plan executes. This is the gate the hands-on SOP licenses
	 *  proceeding on. */
	callerAtTip: boolean;
}

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
	/** Hands-on verdict (present iff mode === "hands-on", dry included). */
	handsOn?: SyncHandsOn;
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
	/** rebase/pull/hands-on ONLY — detached-HEAD recovery. When the calling worktree is
	 * on a detached HEAD, instead of aborting `detached_head`, create this
	 * branch at the current HEAD (or ATTACH it, when a branch of that name
	 * already exists at the exact HEAD) and proceed with the rebase/pull. The
	 * literal `"auto"` derives the name from the worktree folder suffix (see
	 * deriveWorktreeBranchName). Guarded: never the default branch; an existing
	 * branch at a DIFFERENT commit aborts `branch_exists`; a branch checked out
	 * in another worktree aborts `worktree_conflict`. Ignored (warned) in full
	 * mode or when the caller is already on a branch; in hands-on mode it feeds
	 * phase B's detached recovery and defaults to "auto" when omitted. */
	branch?: string;
	signal?: AbortSignal;
}

/** Derive a branch name from the calling worktree's folder name — the `auto`
 *  resolution for the detached-HEAD `branch` option. Session worktrees here
 *  are named `<repo>__<suffix>` (video_generation__memory → "memory"); a bare
 *  folder name (".claude/worktrees/agent-x" → "agent-x") falls through to
 *  itself. Slugified to [a-z0-9-]; may be "" (an unresolvable name the caller
 *  must abort on, never a silent fallback to the default branch). */
export function deriveWorktreeBranchName(repoRoot: string): string {
	const base = (repoRoot.replace(/\/+$/, "").split("/").pop() ?? "").trim();
	const suffix = base.includes("__") ? (base.split("__").filter(Boolean).pop() ?? "") : base;
	return suffix
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
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
	let handsOn: SyncHandsOn | undefined;

	/** Issue a git command: always record it (for `commands`); skip execution
	 *  entirely under dryRun (returns a canned success). */
	const git = async (dir: string, args: string[]): Promise<SpawnResult> => {
		commands.push(renderGit(dir, args));
		if (dry) return { stdout: "", stderr: "(dry-run) skipped", exitCode: 0 };
		return spawn("git", ["-C", dir, ...args]);
	};

	// The preserve park/restore pair (tagged stash push → SHA-paired apply →
	// content-matched drop) is the SHARED module src/preserve.ts — the merge
	// CLI uses the same helpers, so the pairing semantics cannot drift.
	const preserveStash = createPreserveStash({ git, spawn, dry });


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
		handsOn,
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

	let current = await client.currentBranch();
	const detached = !current || current === "HEAD";
	// `branch` is a rebase/pull/hands-on concern: warn (never abort) when it cannot
	// apply — full mode advances <D> elsewhere, and a caller already ON a branch
	// has nothing to recover from. Hands-on handles its own branch warning inside
	// the mode block (phase B decides whether the option applies).
	if (opts.branch && mode !== "hands-on" && (mode === "full" || !detached)) {
		warnings.push(
			mode === "full"
				? `branch option ignored in full mode (full advances '${D}', not the calling worktree's branch).`
				: `branch option ignored — calling worktree is already on '${current}'.`,
		);
	}

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

	// --- HANDS-ON (the SOP one-shot prelude) ------------------------------------
	// Composes the two existing tested paths rather than re-implementing either:
	// phase A = the full-mode advance (verbatim semantics), phase B = the rebase-
	// mode reconcile (with detached-HEAD recovery via `branch`). Phase-B gating is
	// derived from PRE-query state only (where <D> lives + how far the caller
	// lags) — never from post-mutation re-queries — so the mode stays deterministic
	// and the whole flow remains testable against a stateless fake client.
	if (mode === "hands-on") {
		if (opts.branch && !detached) {
			warnings.push(
				`branch option ignored in hands-on mode — calling worktree is already on '${current}'; phase B rebases it.`,
			);
		}
		const worktrees = await client.worktreeList();
		const defaultWt = worktrees.find((w) => w.branch === D)?.worktree;
		const dHeldElsewhere = defaultWt !== undefined && defaultWt !== repoRoot;

		const base = {
			client,
			spawn,
			repoRoot,
			dryRun: dry,
			force,
			preserve,
			remoteName: remote,
			signal: opts.signal,
		};

		// PHASE A — advance <D> wherever it lives. Worktree-aware ff-only default
		// (force opt-in), preserve-listed hot files parked across the advance,
		// checkout <D> in the caller when it is free (the caller then IS at the
		// tip), submodules synced in the caller + the advance target.
		const a = await runSync({ ...base, mode: "full" });
		commands.push(...a.commands);
		warnings.push(...a.warnings);
		if (a.aborted) {
			warnings.push("hands-on phase A (advance the default branch) aborted — caller reconcile skipped.");
			handsOn = { callerAction: "none", callerAtTip: false };
			return outcome({ ...a.aborted, message: `[phase A: advance default branch] ${a.aborted.message}` });
		}
		advanced.push(...a.advanced);
		submodules.push(...a.submodules);
		verification = a.verification;
		caller = a.caller;
		preserved = a.preserved;

		// PHASE B — reconcile the CALLER, only needed when <D> advanced in a
		// DIFFERENT worktree AND the caller actually lags the tip. The lag count
		// is queried POST-FETCH (phase A just fetched, so <remote>/<D> is fresh):
		// a PRE-fetch count is the exact stale-ref trap — a fetch that moves the
		// tip reads behind:0, skips the reconcile, and still claims callerAtTip —
		// the stale-tree failure this mode exists to prevent (reviewer fixture,
		// PR #2174 finding 1). A caller that holds <D> or claimed it via phase A
		// is already at the tip; a detached caller already AT the tip stays
		// detached (attaching a queue-head branch is prepare_feature_branch's
		// job, not this mode's).
		const behindPost = (await client.aheadBehind(`${remote}/${D}`, "HEAD")).behind;
		let b: SyncOutcome | undefined;
		if (dHeldElsewhere && behindPost > 0) {
			// `branch` feeds ONLY the detached recovery — passing it on an attached
			// caller makes the rebase sub-run warn "branch option ignored" (finding 4).
			b = await runSync({ ...base, mode: "rebase", branch: detached ? (opts.branch ?? "auto") : undefined });
			commands.push(...b.commands);
			warnings.push(...b.warnings);
			// preserved/caller merge on EVERY phase-B path — an aborted rebase still
			// ran its park→restore pair, and that outcome must surface structured
			// (finding 5), not only as a warning line.
			caller = b.caller ?? caller;
			preserved = b.preserved ?? preserved;
			if (b.aborted) {
				warnings.push(
					"hands-on phase B (caller reconcile) aborted — the default branch IS advanced (phase A landed); fix the caller and re-run.",
				);
			} else {
				advanced.push(...b.advanced);
			}
		} else if (dHeldElsewhere) {
			warnings.push(`calling worktree already at ${remote}/${D} tip — phase B (caller reconcile) skipped.`);
		}

		// The verdict — DERIVED FROM PHASE SEMANTICS, not a post-hoc probe: every
		// completed phase guarantees 0-behind by git's own semantics (a successful
		// `merge --ff-only` ⇒ <D> == <remote>/<D>; a successful `rebase <remote>/<D>`
		// ⇒ HEAD contains the tip entirely — fast-forwarded, or own commits replayed
		// onto it; a skipped phase B means behindNow was already 0). Probing the tree
		// AFTER the phases would re-query the client, which cannot distinguish pre
		// from post state under a stateless fake — and adds a git call the semantics
		// already pin. An aborted phase ⇒ NOT at tip, by construction.
		const callerAtTip = !b?.aborted && (
			b ? true // phase B rebased the caller onto <remote>/<D> successfully
			: defaultWt === repoRoot // ff-only advanced <D> in the caller itself
				? true
				: defaultWt // <D> advanced elsewhere; B skipped only because POST-FETCH behindPost was 0
					? behindPost === 0
					: true // <D> was free; phase A claimed it here via checkout + ff
		);
		const callerAction: SyncHandsOn["callerAction"] = b?.aborted
			? "reconcile-aborted"
			: b
				? detached
					? "attached-and-rebased"
					: "rebased-current-branch"
				: defaultWt === repoRoot
					? "advanced-default-here"
					: defaultWt
						? "already-at-tip"
						: "claimed-default-here";
		handsOn = { callerAction, callerAtTip };
		if (!callerAtTip) {
			warnings.push(`hands-on: calling worktree is NOT at ${remote}/${D} — fix the abort above and re-run before executing.`);
		}
		if (dry) {
			warnings.push("dry-run: handsOn.callerAtTip projects the plan against current refs (nothing was fetched).");
		}
		return outcome(b?.aborted ? { ...b.aborted, message: `[phase B: caller reconcile] ${b.aborted.message}` } : undefined);
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
			const p = await preserveStash.parkPreserve(advanceTarget, preservable);
			if (p.aborted) return outcome({ aborted: true, reason: "preserve_failed", message: p.aborted });
			if (p.empty) warnings.push(preserveStash.emptyParkWarning(advanceTarget, preservable));
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
		if (park) {
			const r = await preserveStash.restorePreserve(park);
			preserved = r.outcome;
			warnings.push(...r.warnings);
		}

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
	// Pre-flight FIRST (per-path preserve split; see full-mode for the
	// rationale) so an aborting run has mutated NOTHING — including the
	// detached-HEAD branch creation below.
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

	if (detached) {
		// Detached-HEAD recovery (opt-in via `branch`): session worktrees here
		// routinely sit detached (post-merge detach, fresh agent worktree), where
		// a bare rebase/pull cannot run. Without `branch` the historical abort
		// stands; with it, create (or attach) the named branch AT THE CURRENT
		// HEAD — preserving any commits already on the detached HEAD — then fall
		// through to the normal flow, whose rebase/pull reconciles the tip.
		if (!opts.branch) {
			warnings.push("detached HEAD — cannot rebase/merge a detached worktree.");
			return outcome({
				aborted: true,
				reason: "detached_head",
				message: "detached HEAD; cannot advance a detached worktree",
				hint: "pass branch:'<name>' (or 'auto' to derive one from the worktree folder) to create a branch at the current HEAD and proceed.",
			});
		}
		const name = opts.branch === "auto" ? deriveWorktreeBranchName(repoRoot) : opts.branch;
		// Guard 1 — resolvable + never the default branch (syncing <D> is full
		// mode's job; a local <D> here would also collide with the worktree that
		// holds it).
		if (!name || name === D) {
			return outcome({
				aborted: true,
				reason: "branch_name_invalid",
				message: `resolved branch name '${name || ""}' is empty or is the default branch '${D}' — refusing to create it.`,
				hint: "pass an explicit non-default branch name (branch:'auto' derives one from the worktree folder suffix).",
			});
		}
		// Guard 2 — checked out in ANOTHER worktree: `git checkout` would fatal.
		// Read-only, aborts regardless of dryRun (structural — nothing to plan).
		const worktrees = await client.worktreeList();
		if (worktrees.some((w) => w.branch === name && w.worktree !== repoRoot)) {
			return outcome({
				aborted: true,
				reason: "worktree_conflict",
				message: `branch '${name}' is already checked out in another worktree — refusing to check it out here.`,
				hint: `git worktree list shows '${name}' elsewhere; pass a different branch name.`,
			});
		}
		// Guard 3 — a branch of that name already existing at a DIFFERENT commit
		// must never be silently moved (checkout -b would fatal; attaching would
		// abandon the detached HEAD commits). Existing at the EXACT HEAD is safe:
		// plain `git checkout <name>` attaches without moving anything.
		const head = (await client.revParse("HEAD")) ?? "";
		const existing = (await client.revParse(`refs/heads/${name}`)) ?? "";
		if (existing && existing !== head) {
			return outcome({
				aborted: true,
				reason: "branch_exists",
				message: `branch '${name}' already exists at ${existing.slice(0, 12)}, which is not the current HEAD (${head.slice(0, 12)}).`,
				hint: `pass a different branch name, or check out '${name}' deliberately if that is what you meant.`,
			});
		}
		const co = existing
			? await git(repoRoot, ["checkout", name])
			: await git(repoRoot, ["checkout", "-b", name]);
		if (!dry && co.exitCode !== 0) {
			warnings.push(`git checkout ${existing ? "" : "-b "}${name} failed: ${trim(co.stderr || co.stdout)}`);
			return outcome({ aborted: true, reason: "checkout_failed", message: `checkout ${existing ? "" : "-b "}${name} failed` });
		}
		current = name;
		warnings.push(`detached HEAD — ${existing ? `attached existing branch` : `created branch`} '${name}' at HEAD (${head.slice(0, 12)}); proceeding with ${mode} mode.`);
	}

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
		const p = await preserveStash.parkPreserve(repoRoot, preservable);
		if (p.aborted) return outcome({ aborted: true, reason: "preserve_failed", message: p.aborted });
		if (p.empty) warnings.push(preserveStash.emptyParkWarning(repoRoot, preservable));
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
	if (park) {
		const r = await preserveStash.restorePreserve(park);
		preserved = r.outcome;
		warnings.push(...r.warnings);
	}

	if (advanceAborted) return outcome(advanceAborted);
	const after = (await client.revParse("HEAD")) ?? "";
	const { count, subjects } = await advancedCommits(from, after);
	advanced.push({ worktree: repoRoot, branch: current, from, to: after, count, subjects });
	// Post-run caller snapshot (behind-default warning when the caller lags).
	caller = await callerPostState();
	return outcome();
}
