/**
 * runSync — the PURE orchestration behind the `sync_repo` tool. A TypeScript
 * port of scripts/sync-repo.sh (+ scripts/git-remote-main-sync.sh), agent-invoked
 * only (no shell/CLI entry point). This is ticket 02 of the "move sync into
 * devops" wayfinder map; the bash scripts are intentionally left in place for
 * ticket 03 to remove once this tool has replaced every consumer.
 *
 * Three modes (the only flags ticket 01 proved in use):
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

/**
 * The read-only git surface sync_repo needs. A `Pick` of BranchClient so the
 * live `createBranchClient` (full BranchClient) satisfies it, while tests inject
 * a minimal fake covering only these six methods.
 */
export type SyncClient = Pick<
	BranchClient,
	"defaultBranch" | "currentBranch" | "worktreeList" | "revParse" | "isClean" | "aheadBehind"
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
}

export interface SyncSubmodule {
	path: string;
	sha: string;
	clean: boolean;
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
	/** Machine reason: "aborted_before_start" | "dirty_tree" | "no_origin_ref"
	 *  | "checkout_failed" | "merge_ff_failed" (→ "divergent") | "reset_failed"
	 *  | "detached_head" | "rebase_failed" | "merge_failed". */
	reason: string;
	/** Human-readable summary (what happened + immediate remediation). */
	message: string;
	/** The default branch, when relevant to the reason (divergent). */
	defaultBranch?: string;
	/** Actionable hint, when relevant (divergent → force:true). */
	hint?: string;
}

export interface SyncOutcome {
	mode: SyncMode;
	dryRun: boolean;
	/** Auto-detected default branch (short name; "main" on detection failure). */
	defaultBranch: string;
	/** Branch advancements performed (empty in an aborted run; populated under dryRun). */
	advanced: SyncAdvanced[];
	/** Full-mode submodule report (parsed `git submodule status --recursive`). */
	submodules: SyncSubmodule[];
	/** Pre-flight issues (uncommitted, unpushed, verification drift). */
	warnings: string[];
	/** Every git command issued, rendered runnable (`git -C "<dir>" <args>`).
	 *  Always populated; the primary output under dryRun. */
	commands: string[];
	/** Set when a mutating mode refused to run (dirty tree, divergent, …). */
	aborted?: SyncAbort;
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
	const { client, spawn, repoRoot } = opts;
	const commands: string[] = [];
	const warnings: string[] = [];
	const advanced: SyncAdvanced[] = [];
	const submodules: SyncSubmodule[] = [];

	/** Issue a git command: always record it (for `commands`); skip execution
	 *  entirely under dryRun (returns a canned success). */
	const git = async (dir: string, args: string[]): Promise<SpawnResult> => {
		commands.push(renderGit(dir, args));
		if (dry) return { stdout: "", stderr: "(dry-run) skipped", exitCode: 0 };
		return spawn("git", ["-C", dir, ...args]);
	};

	// --- 1. Detect the default branch (read-only; runs under dryRun too). -----
	// origin/HEAD symbolic-ref → short name (main/master/develop/release/v2…).
	// Detection failure falls back to "main" (the bash hard fallback); the
	// network `git remote show origin` fallback is intentionally omitted (these
	// tools stay offline) — surfaced as a warning instead.
	let D = await client.defaultBranch();
	if (!D) {
		D = "main";
		warnings.push("could not detect default branch via origin/HEAD; falling back to 'main'.");
	}
	const outcome = (aborted?: SyncAbort): SyncOutcome => ({
		mode,
		dryRun: dry,
		defaultBranch: D,
		advanced,
		submodules,
		warnings,
		commands,
		aborted,
		elapsedMs: Date.now() - t0,
	});

	if (opts.signal?.aborted) {
		warnings.push("aborted before start.");
		return outcome({ aborted: true, reason: "aborted_before_start", message: "aborted before start." });
	}

	const current = await client.currentBranch();

	// --- 2. Pre-flight: unpushed-commit warnings (read-only; best-effort). ----
	// A missing upstream (origin/<branch> not fetched) → aheadBehind returns 0.
	if (current && current !== "HEAD") {
		const ab = await client.aheadBehind(`origin/${current}`, current);
		if (ab.ahead > 0) warnings.push(`${current} is ${ab.ahead} commit(s) ahead of origin/${current} (unpushed).`);
	}
	const dab = await client.aheadBehind(`origin/${D}`, D);
	if (dab.ahead > 0) {
		// In default full-mode these commits block the fast-forward (the recipe
		// aborts below); under force:true they're discarded by reset --hard.
		warnings.push(
			`default branch '${D}' is ${dab.ahead} commit(s) ahead of origin/${D} (unpushed) — full mode's fast-forward will refuse them; force:true discards them via reset --hard.`,
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

		// Pre-flight: the worktree holding <D> must be clean (both merge --ff-only
		// and reset --hard on a dirty tree risk losing staged/unstaged tracked
		// work). Warn always; abort only when actually mutating.
		const clean = await client.isClean(advanceTarget);
		if (!clean) warnings.push(`worktree '${advanceTarget}' has uncommitted tracked changes.`);
		if (!dry && !clean) {
			return outcome({
				aborted: true,
				reason: "dirty_tree",
				message: `dirty tree at ${advanceTarget}; aborting before fetch (stash or commit first).`,
			});
		}

		// 4. Fetch (mutating; skipped under dryRun).
		await git(repoRoot, ["fetch", "origin"]);

		// 5. Resolve the target SHA (origin/<D> must exist post-fetch).
		const to = await client.revParse(`origin/${D}`);
		if (!to) {
			warnings.push(`cannot resolve origin/${D} — is remote 'origin' fetched?`);
			return outcome({ aborted: true, reason: "no_origin_ref", message: `cannot resolve origin/${D}` });
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

		if (force) {
			// 7a. DESTRUCTIVE (opt-in): reset --hard origin/<D> — discards any
			//     divergent/unpushed commits on <D>. Warned in the result.
			const reset = await git(advanceTarget, ["reset", "--hard", `origin/${D}`]);
			if (reset.exitCode !== 0) {
				warnings.push(`reset --hard failed: ${trim(reset.stderr || reset.stdout)}`);
				return outcome({ aborted: true, reason: "reset_failed", message: `reset --hard origin/${D} failed` });
			}
			warnings.push(
				`force:true — used 'git reset --hard origin/${D}', which discards any divergent/unpushed commits on '${D}'.`,
			);
		} else {
			// 7b. SAFE DEFAULT: merge --ff-only. We already fetched, so this avoids
			//     pull's double-fetch. git REFUSES (exit non-zero) when local <D>
			//     has divergent/unpushed commits — so the fast-forward can NEVER
			//     lose a commit. On refusal, abort (no reset, no submodule sync)
			//     and tell the caller exactly how to force the destructive path.
			const ff = await git(advanceTarget, ["merge", "--ff-only", `origin/${D}`]);
			if (ff.exitCode !== 0) {
				return outcome({
					aborted: true,
					reason: "divergent",
					defaultBranch: D,
					message: `default branch '${D}' has commits not on origin/${D}; refusing to fast-forward.`,
					hint: `default branch '${D}' has commits not on origin/${D}; refusing to fast-forward. Re-run with force:true to reset --hard (discards those local commits).`,
				});
			}
		}
		advanced.push({ worktree: advanceTarget, branch: D, from, to });

		// 8. Verify local <D> now equals origin/<D> (the bash verify_default_at_latest
		//    guard — turns a silent skipped-advance into a loud warning).
		if (!dry) {
			const localD = await client.revParse(D);
			if (localD && localD !== to) {
				warnings.push(`verification: local '${D}' (${localD.slice(0, 12)}) != origin/${D} (${to.slice(0, 12)}).`);
			}
		}

		// 9. Recursive submodule sync (full only): fetch each, advance every
		//    submodule to its configured remote tip, reconcile paths, then report.
		await git(repoRoot, ["submodule", "foreach", "--recursive", "git", "fetch", "--all", "--prune"]);
		await git(repoRoot, ["submodule", "update", "--init", "--recursive", "--remote"]);
		await git(repoRoot, ["submodule", "sync", "--recursive"]);
		const status = await git(repoRoot, ["submodule", "status", "--recursive"]);
		for (const s of parseSubmoduleStatus(status.stdout)) {
			submodules.push({ path: s.path, sha: s.sha, clean: s.flag === "" });
		}
		return outcome();
	}

	// --- REBASE / PULL (the current branch with origin/<D>) ------------------
	if (!current || current === "HEAD") {
		warnings.push("detached HEAD — cannot rebase/merge a detached worktree.");
		return outcome({ aborted: true, reason: "detached_head", message: "detached HEAD; cannot advance a detached worktree" });
	}
	const clean = await client.isClean(repoRoot);
	if (!clean) warnings.push(`worktree '${repoRoot}' has uncommitted tracked changes.`);
	if (!dry && !clean) {
		return outcome({
			aborted: true,
			reason: "dirty_tree",
			message: `dirty tree at ${repoRoot}; aborting before fetch (stash or commit first).`,
		});
	}

	await git(repoRoot, ["fetch", "origin"]);

	const remoteTip = await client.revParse(`origin/${D}`);
	if (!remoteTip) {
		warnings.push(`cannot resolve origin/${D} — is remote 'origin' fetched?`);
		return outcome({ aborted: true, reason: "no_origin_ref", message: `cannot resolve origin/${D}` });
	}
	const from = (await client.revParse("HEAD")) ?? "";

	if (mode === "rebase") {
		const r = await git(repoRoot, ["rebase", `origin/${D}`]);
		if (r.exitCode !== 0) {
			warnings.push(`rebase failed: ${trim(r.stderr || r.stdout)}`);
			return outcome({ aborted: true, reason: "rebase_failed", message: `rebase onto origin/${D} failed (resolve conflicts, then re-run).` });
		}
	} else {
		// pull → real merge, never fast-forward (per spec: "merge instead of ff").
		const r = await git(repoRoot, ["merge", "--no-edit", "--no-ff", `origin/${D}`]);
		if (r.exitCode !== 0) {
			warnings.push(`merge failed: ${trim(r.stderr || r.stdout)}`);
			return outcome({ aborted: true, reason: "merge_failed", message: `merge origin/${D} failed (resolve conflicts, then re-run).` });
		}
	}
	const after = (await client.revParse("HEAD")) ?? "";
	advanced.push({ worktree: repoRoot, branch: current, from, to: after });
	return outcome();
}
