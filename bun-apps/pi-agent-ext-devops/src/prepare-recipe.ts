/**
 * runPrepare — the PURE orchestration behind a worktree-aware branch
 * create / rebase / force-push. MUTATING (unlike runRetrospect): every mutating
 * git call funnels through the injected `SpawnFn`, and every one is recorded in
 * `commands[]`. Composable via three independent booleans (`create`, `rebase`,
 * `forcePush`) so a single call can, e.g., create a branch off the default
 * base, rebase it, then force-push — or any subset.
 *
 * Flow (in fixed order; each step is gated by its boolean):
 *   0. Detached-HEAD guard (always): a caller on a detached HEAD with no
 *      explicit `branch` resolves to "" — flowing verbatim into
 *      `git checkout -b ""` / `git push origin ""`. Aborts `detached-head`
 *      BEFORE any checkout/push (zero spawns, regardless of dryRun).
 *   1. Worktree guard (always; read-only): if the target branch is checked out
 *      in a worktree OTHER than this one → abort `worktree-conflict` BEFORE any
 *      mutation (zero spawns). Checking a branch out twice fatals in git; this
 *      guard prevents it.
 *   2. `create` → `git checkout -b <branch> <base>` (base defaults to
 *      `origin/<defaultBranch>`). Non-zero → abort `create-failed`.
 *   3. `rebase` → `git rebase <base> <branch>` — the branch is named, so this
 *      checks it out rather than rebasing whatever HEAD happens to be; on
 *      conflict (exit!=0) run `git rebase --abort` (recorded) then abort
 *      `rebase-conflict`. Around this step the outcome reports
 *      `head: {from, to}` (HEAD before/after).
 *   4. `forcePush` (only when explicitly true) →
 *      `git push --force-with-lease origin <branch>`; non-zero → abort
 *      `force-push-failed`. When `forcePush` is falsy NO push command is ever
 *      issued (the default — never force-pushes by accident).
 *   5. Reporting (read-only): completed runs carry `head` + post-run
 *      `aheadBehind` vs `base` (see PrepareOutcome).
 *
 * Throw-free discipline (mirrors sync-recipe.ts): every refusal surfaces as a
 * structured `aborted` descriptor + `warnings[]`; the outcome carries a `steps`
 * log ({step, ok} per attempted step) so the caller can render a clean block.
 * `dryRun` computes + records the exact commands WITHOUT spawning a single
 * mutation (read-only client queries still run, so the plan is accurate).
 */
import type { SpawnFn, SpawnResult } from "./spawn.js";
import type { BranchClient } from "./branch-recipe.js";

/**
 * The read-only surface prepare needs for its guard + base resolution. A `Pick`
 * of BranchClient so the live `createBranchClient` satisfies it; tests inject a
 * minimal fake covering only these four methods.
 */
export type PrepareClient = Pick<
	BranchClient,
	"currentBranch" | "defaultBranch" | "worktreeList" | "revParse" | "aheadBehind"
>;

export type PrepareStepName = "create" | "rebase" | "forcePush";

export interface PrepareStep {
	step: PrepareStepName;
	ok: boolean;
}

export interface PrepareAbort {
	/** Always true — discriminator (present only on an aborted run). */
	aborted: true;
	/** Machine reason — one of PREPARE_ABORT_REASONS: "aborted-before-start" |
	 *  "detached-head" | "worktree-conflict" | "create-failed" |
	 *  "rebase-conflict" | "force-push-failed". */
	reason: PrepareAbortReason;
	/** Human-readable summary (what happened + immediate remediation). */
	message: string;
	/** Actionable hint, when relevant. */
	hint?: string;
}

/** Every abort reason runPrepare can actually emit (the PrepareAbort.reason
 *  union — kept in sync with the `outcome({ aborted: true, reason: … })` sites
 *  below). Hyphenated, mirroring prepare_branch's own historical style;
 *  deliberately NOT shared with snake_case SYNC_ABORT_REASONS (sync-recipe).
 */
export const PREPARE_ABORT_REASONS = [
	"aborted-before-start",
	"detached-head",
	"worktree-conflict",
	"create-failed",
	"rebase-conflict",
	"force-push-failed",
] as const;

export type PrepareAbortReason = (typeof PREPARE_ABORT_REASONS)[number];

export interface PrepareOutcome {
	branch: string;
	base: string;
	/** HEAD SHAs around the mutation sequence: `from` resolved before any
	 *  mutation, `to` resolved after the rebase — the only step that moves HEAD
	 *  (`checkout -b` keeps the same commit). On an aborted run `to === from`
	 *  (create-failed leaves HEAD; rebase-conflict's recorded `rebase --abort`
	 *  restores it). "" when the SHA is unresolvable. */
	head: { from: string; to: string };
	/** Present on completed (non-aborted) runs: how `branch` stands vs `base`
	 *  AFTER the run — `ahead` = commits on the branch but not base (expected
	 *  after a rebase), `behind` = commits on base but not the branch (0 after
	 *  a successful rebase; >0 without one means base has moved). {0,0} with a
	 *  pushed warning when the read itself fails. Under dryRun this reflects
	 *  the pre-run state (read-only queries still run; nothing mutated). */
	aheadBehind?: { ahead: number; behind: number };
	/** One entry per attempted step (in order); ok = exit 0. */
	steps: PrepareStep[];
	/** Every mutating git command issued, rendered runnable. */
	commands: string[];
	warnings: string[];
	/** Present when the run refused to proceed (guard/conflict/push failure). */
	aborted?: PrepareAbort;
}

export interface PrepareOptions {
	client: PrepareClient;
	spawn: SpawnFn;
	repoRoot: string;
	/** Target branch. Default: the current branch. */
	branch?: string;
	/** Rebase/create base. Default: `origin/<defaultBranch>`. */
	base?: string;
	/** Create the branch off `base` (`git checkout -b`). */
	create?: boolean;
	/** Rebase the branch onto `base`. */
	rebase?: boolean;
	/** Force-push the branch (`--force-with-lease`). Default false (never). */
	forcePush?: boolean;
	/** Compute + record commands; spawn ZERO mutations. */
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

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Run `fn`; on a thrown error, record a `warning` and return `fallback`. */
async function safe<T>(label: string, fn: () => Promise<T>, fallback: T, warnings: string[]): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		warnings.push(`${label} read failed: ${errMsg(err)}`);
		return fallback;
	}
}

/**
 * Run the prepare recipe. Never throws — every refusal (worktree conflict,
 * failed checkout/rebase/push) surfaces as a structured `aborted` descriptor +
 * `warnings` in the outcome. `dryRun` records the plan without mutating.
 */
export async function runPrepare(opts: PrepareOptions): Promise<PrepareOutcome> {
	const { client, spawn, repoRoot } = opts;
	const dry = opts.dryRun === true;
	const commands: string[] = [];
	const warnings: string[] = [];
	const steps: PrepareStep[] = [];

	/** Issue a git command: always record it (for `commands`); skip execution
	 *  entirely under dryRun (returns a canned success). */
	const git = async (dir: string, args: string[]): Promise<SpawnResult> => {
		commands.push(renderGit(dir, args));
		if (dry) return { stdout: "", stderr: "(dry-run) skipped", exitCode: 0 };
		return spawn("git", ["-C", dir, ...args]);
	};

	// --- 1. Resolve branch + base (read-only; runs under dryRun too). ----------
	const current = await safe("currentBranch", () => client.currentBranch(), "", warnings);
	const detectedDefault =
		(await safe("defaultBranch", () => client.defaultBranch(), undefined, warnings)) ?? "main";
	const branch = opts.branch ?? current;
	const base = opts.base ?? `origin/${detectedDefault}`;

	/** HEAD around the mutation sequence (see PrepareOutcome.head). */
	const head: { from: string; to: string } = { from: "", to: "" };

	const outcome = (aborted?: PrepareAbort, aheadBehind?: { ahead: number; behind: number }): PrepareOutcome => ({
		branch,
		base,
		head: { ...head },
		...(aheadBehind ? { aheadBehind } : {}),
		steps,
		commands,
		warnings,
		aborted,
	});

	if (opts.signal?.aborted) {
		warnings.push("aborted before start.");
		return outcome({ aborted: true, reason: "aborted-before-start", message: "aborted before start." });
	}

	// --- 1. Detached-HEAD guard (hard gate). -----------------------------------
	// A detached caller with no explicit `branch` resolves to "" — which would
	// flow verbatim into `git checkout -b ""` / `git push origin ""`. Refuse
	// BEFORE any checkout/push (zero spawns, regardless of dryRun).
	if (branch === "") {
		return outcome({
			aborted: true,
			reason: "detached-head",
			message: "caller is on a detached HEAD and no explicit branch was given — resolved branch name is empty.",
			hint: "pass an explicit branch (prepare_branch --branch <name>) or check out a branch first.",
		});
	}

	// HEAD before any mutation (read-only; runs under dryRun too). Aborts
	// restore HEAD, so `to` starts at `from` and only a completed rebase moves it.
	head.from = (await safe("revParse HEAD (from)", () => client.revParse("HEAD"), "", warnings)) ?? "";
	head.to = head.from;

	// --- 2. Worktree guard (read-only; hard structural gate). ------------------
	// The target branch checked out in ANOTHER worktree means `checkout` would
	// fatal — refuse up front, before any mutation. Aborts regardless of dryRun
	// (a structural conflict has nothing to plan around).
	const worktrees = await safe("worktreeList", () => client.worktreeList(), [], warnings);
	const conflict = worktrees.some((w) => w.branch === branch && branch && w.worktree !== repoRoot);
	if (conflict) {
		return outcome({
			aborted: true,
			reason: "worktree-conflict",
			message: `branch '${branch}' is checked out in another worktree — refusing to mutate.`,
			hint: "switch to that worktree, or pick a different branch name.",
		});
	}

	// --- 3. create -------------------------------------------------------------
	if (opts.create) {
		const co = await git(repoRoot, ["checkout", "-b", branch, base]);
		steps.push({ step: "create", ok: co.exitCode === 0 });
		if (co.exitCode !== 0) {
			warnings.push(`git checkout -b ${branch} ${base} failed: ${trim(co.stderr || co.stdout)}`);
			return outcome({
				aborted: true,
				reason: "create-failed",
				message: `git checkout -b ${branch} ${base} failed.`,
				hint: `branch '${branch}' may already exist; choose another name.`,
			});
		}
	}

	// --- 4. rebase -------------------------------------------------------------
	// The only step that moves HEAD (`checkout -b` keeps the same commit), so
	// `head.to` is resolved right after it.
	//
	// `<branch>` is passed explicitly. `git rebase <base>` alone rebases whatever
	// HEAD happens to be, so a caller sitting on the default branch who asked to
	// rebase a DIFFERENT branch used to get a no-op reported as `{step: "rebase",
	// ok: true}` — the branch untouched, still BEHIND, which is the one thing
	// this step exists to clear. `git rebase <base> <branch>` checks the branch
	// out first, so the step operates on the branch the caller named. The
	// worktree guard above has already refused the case where that checkout
	// would fatal. Note this leaves HEAD on `branch`, like `create` does.
	if (opts.rebase) {
		const r = await git(repoRoot, ["rebase", base, branch]);
		steps.push({ step: "rebase", ok: r.exitCode === 0 });
		if (r.exitCode !== 0) {
			warnings.push(`rebase ${base} ${branch} failed: ${trim(r.stderr || r.stdout)}`);
			// Abort the in-progress rebase (recorded), then surface the abort.
			await git(repoRoot, ["rebase", "--abort"]);
			return outcome({
				aborted: true,
				reason: "rebase-conflict",
				message: `rebase onto ${base} failed (conflicts); rebase aborted.`,
				hint: "resolve conflicts locally, then re-run prepare.",
			});
		}
		head.to = (await safe("revParse HEAD (to)", () => client.revParse("HEAD"), head.from, warnings)) ?? head.from;
	}

	// --- 5. forcePush (ONLY when explicitly opted in) --------------------------
	if (opts.forcePush) {
		const p = await git(repoRoot, ["push", "--force-with-lease", "origin", branch]);
		steps.push({ step: "forcePush", ok: p.exitCode === 0 });
		if (p.exitCode !== 0) {
			warnings.push(`push --force-with-lease origin ${branch} failed: ${trim(p.stderr || p.stdout)}`);
			return outcome({
				aborted: true,
				reason: "force-push-failed",
				message: `git push --force-with-lease origin ${branch} failed.`,
				hint: "the remote tip may have moved; fetch + rebase, then re-run.",
			});
		}
	}

	// --- 6. Reporting (read-only; completed runs). ------------------------------
	const aheadBehind = await safe(
		"aheadBehind",
		() => client.aheadBehind(base, branch),
		{ ahead: 0, behind: 0 },
		warnings,
	);
	return outcome(undefined, aheadBehind);
}
