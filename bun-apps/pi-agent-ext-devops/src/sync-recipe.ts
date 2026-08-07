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
 * Pre-flight (all modes): an uncommitted (dirty) tracked tree aborts every
 * MUTATING run (matches the bash `need_clean_tree` gate); unpushed commits are
 * surfaced as warnings only (full mode's reset --hard on the default branch
 * would discard them, hence the loud warning). dryRun computes + returns the
 * exact git commands without spawning a single mutating op — read-only queries
 * (default-branch detection, worktree list, from/to SHAs, clean/ahead checks)
 * still run, so the dry-run plan + warnings are accurate.
 *
 * Every MUTATING git call funnels through the injected `SpawnFn` (the same seam
 * ci-recipe/recipe use); read-only git queries go through the injected
 * `SyncClient` (a Pick of BranchClient, extended with worktreeList/revParse/
 * isClean/aheadBehind in src/gh.ts). So the whole flow is fully testable with
 * fakes — no real git / filesystem — mirroring how runLocalCi is tested.
 *
 * Bash parity notes (deliberate deviations, ticket 02 scope):
 *   - full-mode default-branch advance uses `git reset --hard origin/<D>` (per
 *     the tool spec) rather than the bash `pull --ff-only`. The default branch
 *     is a pristine origin mirror by repo convention, and the result's
 *     `from`/`to` make any discarded commits visible; unpushed commits on <D>
 *     are warned pre-flight.
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
	/** Set (with a reason) when a mutating mode refused to run (dirty tree, etc.). */
	aborted?: string;
	elapsedMs: number;
}

export interface SyncOptions {
	client: SyncClient;
	spawn: SpawnFn;
	repoRoot: string;
	mode?: SyncMode;
	dryRun?: boolean;
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
 * failed reset/rebase/merge) surfaces as `aborted` + `warnings` in the
 * structured outcome (mirrors runMergeRecipe's throw-free discipline).
 */
export async function runSync(opts: SyncOptions): Promise<SyncOutcome> {
	const t0 = Date.now();
	const mode: SyncMode = opts.mode ?? "full";
	const dry = opts.dryRun === true;
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
	const outcome = (aborted?: string): SyncOutcome => ({
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
		return outcome("aborted before start");
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
		warnings.push(
			`default branch '${D}' is ${dab.ahead} commit(s) ahead of origin/${D} (unpushed) — full mode's reset --hard would discard them.`,
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

		// Pre-flight: the worktree holding <D> must be clean (reset --hard on a
		// dirty tree would lose staged/unstaged tracked work). Warn always; abort
		// only when actually mutating.
		const clean = await client.isClean(advanceTarget);
		if (!clean) warnings.push(`worktree '${advanceTarget}' has uncommitted tracked changes.`);
		if (!dry && !clean) {
			return outcome(`dirty tree at ${advanceTarget}; aborting before fetch (stash or commit first).`);
		}

		// 4. Fetch (mutating; skipped under dryRun).
		await git(repoRoot, ["fetch", "origin"]);

		// 5. Resolve the target SHA (origin/<D> must exist post-fetch).
		const to = await client.revParse(`origin/${D}`);
		if (!to) {
			warnings.push(`cannot resolve origin/${D} — is remote 'origin' fetched?`);
			return outcome(`cannot resolve origin/${D}`);
		}

		// 6. If <D> was free, check it out here first; then advance (reset --hard).
		if (needCheckout) {
			const co = await git(repoRoot, ["checkout", D]);
			if (co.exitCode !== 0) {
				warnings.push(`git checkout ${D} failed: ${trim(co.stderr || co.stdout)}`);
				return outcome(`checkout ${D} failed`);
			}
		}
		const from = (await client.revParse(D)) ?? "";
		const reset = await git(advanceTarget, ["reset", "--hard", `origin/${D}`]);
		if (reset.exitCode !== 0) {
			warnings.push(`reset --hard failed: ${trim(reset.stderr || reset.stdout)}`);
			return outcome(`reset --hard origin/${D} failed`);
		}
		advanced.push({ worktree: advanceTarget, branch: D, from, to });

		// 7. Verify local <D> now equals origin/<D> (the bash verify_default_at_latest
		//    guard — turns a silent skipped-advance into a loud warning).
		if (!dry) {
			const localD = await client.revParse(D);
			if (localD && localD !== to) {
				warnings.push(`verification: local '${D}' (${localD.slice(0, 12)}) != origin/${D} (${to.slice(0, 12)}).`);
			}
		}

		// 8. Recursive submodule sync (full only): fetch each, advance every
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
		return outcome("detached HEAD; cannot advance a detached worktree");
	}
	const clean = await client.isClean(repoRoot);
	if (!clean) warnings.push(`worktree '${repoRoot}' has uncommitted tracked changes.`);
	if (!dry && !clean) {
		return outcome(`dirty tree at ${repoRoot}; aborting before fetch (stash or commit first).`);
	}

	await git(repoRoot, ["fetch", "origin"]);

	const remoteTip = await client.revParse(`origin/${D}`);
	if (!remoteTip) {
		warnings.push(`cannot resolve origin/${D} — is remote 'origin' fetched?`);
		return outcome(`cannot resolve origin/${D}`);
	}
	const from = (await client.revParse("HEAD")) ?? "";

	if (mode === "rebase") {
		const r = await git(repoRoot, ["rebase", `origin/${D}`]);
		if (r.exitCode !== 0) {
			warnings.push(`rebase failed: ${trim(r.stderr || r.stdout)}`);
			return outcome(`rebase onto origin/${D} failed (resolve conflicts, then re-run).`);
		}
	} else {
		// pull → real merge, never fast-forward (per spec: "merge instead of ff").
		const r = await git(repoRoot, ["merge", "--no-edit", "--no-ff", `origin/${D}`]);
		if (r.exitCode !== 0) {
			warnings.push(`merge failed: ${trim(r.stderr || r.stdout)}`);
			return outcome(`merge origin/${D} failed (resolve conflicts, then re-run).`);
		}
	}
	const after = (await client.revParse("HEAD")) ?? "";
	advanced.push({ worktree: repoRoot, branch: current, from, to: after });
	return outcome();
}
