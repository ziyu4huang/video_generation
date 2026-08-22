/**
 * runMainHealth — "is the default branch green right now?"
 *
 * WHY THIS EXISTS
 *   `run_local_ci` is CHANGE-SCOPED (packages touched vs origin/main) and remote CI
 *   is disabled in this repo. Together those mean a branch that happens not to
 *   touch a broken package merges green forever, and no step in the devops chain
 *   ever reports that the default branch itself is failing. On 2026-08-15 main
 *   had been red on `s2-agent` for days and had just gone red on
 *   `s2-agent-ext-obsidian`; the only way anyone found out was running the whole
 *   matrix by hand.
 *
 * WHAT MAKES THE ANSWER HONEST
 *   A test suite runs against a WORKING TREE, never against a ref. Running it
 *   from a feature-branch worktree and calling the result "main's health" would
 *   be a lie. So this locates the worktree that actually holds the default
 *   branch and runs there. When no such worktree exists it ABORTS — reporting
 *   "healthy" because there was nothing to test is the same false-green
 *   src/ci-gates.ts fails closed on.
 *
 *   When that tree is dirty, or behind its remote, the run still happens (the
 *   information is worth having) but the outcome carries a `warnings` entry
 *   saying so, because the verdict is then about that tree and not about
 *   `origin/<default>`.
 *
 * THE TEMP-WORKTREE FALLBACK (2026-08-18)
 *   This repo's steady state is ALL-DETACHED worktrees — every sibling checkout
 *   is `git worktree add --detach` — so "find the worktree holding <D>" never
 *   held and the tool could only ever abort; "is main green?" was unanswerable.
 *   Instead of giving up, the recipe now MINTS a throwaway detached worktree at
 *   `<D>` under the OS temp dir, runs the suite there, and ALWAYS removes it
 *   (try/finally). A freshly minted tree at <D> is in some ways a MORE honest
 *   subject than a long-lived checkout: it cannot be dirty. Only if even the
 *   `git worktree add` fails does it abort with the original reason.
 *
 * DEPTH, NOT A NEW ENGINE
 *   Everything about running the suite already exists in `runLocalCi` — this
 *   adds only "which tree, and how do I qualify the answer". `runCi` is
 *   injectable so the whole flow is testable with zero git/filesystem.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SpawnFn } from "./spawn.js";
import type { BranchClient } from "./branch-recipe.js";
import { runLocalCi, type CiOutcome, type CiOptions } from "./ci-recipe.js";
import type { CiGatesResult } from "./ci-gates.js";

/**
 * The read-only git surface this needs — a `Pick` of BranchClient, so the live
 * `createBranchClient` satisfies it and tests inject a five-method fake.
 */
export type MainHealthClient = Pick<
	BranchClient,
	"defaultBranch" | "worktreeList" | "dirtyPaths" | "aheadBehind" | "revParse"
>;

export interface MainHealthOptions {
	client: MainHealthClient;
	spawn: SpawnFn;
	signal?: AbortSignal;
	/** Injectable local-CI runner. Default: `runLocalCi`. */
	runCi?: (opts: CiOptions) => Promise<CiOutcome>;
	/** Forwarded to runLocalCi (tests keep it filesystem-free). */
	readGates?: (repoRoot: string) => Promise<CiGatesResult>;
	/** Forwarded to runLocalCi — keeps the schema-cost banner off a JSON stdout. */
	log?: (line: string) => void;
	/** Remote name for the `origin/<D>` freshness refs + runLocalCi's default
	 *  base (default `origin`; resolve via src/remote.ts and pass down). */
	remoteName?: string;
}

export interface MainHealthOutcome {
	/** True only when the suite RAN and came back green. Never true on an abort. */
	healthy: boolean;
	defaultBranch: string;
	/** Absolute path of the worktree the suite ran in (absent on abort). */
	worktree?: string;
	/**
	 * Set when no worktree held the default branch and a THROWAWAY detached
	 * worktree was minted for the run. The path names a tree that no longer
	 * exists by the time the outcome is returned — it is provenance, not a dir
	 * to reuse. Absent on abort and on the held-worktree path.
	 */
	tempWorktree?: string;
	/** The commit actually tested (absent on abort). */
	head?: string;
	/** Set when nothing ran. `healthy` is then false. */
	aborted?: "no-default-branch-worktree";
	/** Human-readable reason, present whenever `aborted` is. */
	message?: string;
	/** Caveats about WHAT was tested — a dirty or behind tree. Never a failure. */
	warnings: string[];
	/** Packages whose test, (non-skipped) typecheck, or (non-skipped) lint genuinely failed. */
	failingPackages: string[];
	/**
	 * Packages whose typecheck exited 127 — the command does not exist, i.e. that
	 * worktree has no deps installed. An ENVIRONMENT problem, not a broken branch,
	 * and kept out of `failingPackages` so the real failures stay legible. The
	 * check did not run though, so the branch is still not verified.
	 */
	toolchainMissing: string[];
	/** Gates that exited non-zero. */
	failingGates: string[];
	/** Carried up from run_local_ci when the gate job itself could not be read. */
	gateError?: string;
	/** The full underlying outcome, for callers that want the detail. */
	ci?: CiOutcome;
	elapsedMs: number;
}

export async function runMainHealth(opts: MainHealthOptions): Promise<MainHealthOutcome> {
	const t0 = Date.now();
	const { client } = opts;
	const remote = opts.remoteName ?? "origin";
	const defaultBranch = (await client.defaultBranch()) || "main";

	// 1. Find the worktree holding <D>. A detached worktree holds no branch, so
	//    `branch` is undefined there and can never match.
	const worktrees = await client.worktreeList();
	const held = worktrees.find((w) => w.branch === defaultBranch);

	// 1b. No holder → the TEMP-WORKTREE FALLBACK: mint a detached worktree at
	//     <D> under the OS temp dir. `git worktree list` always names the MAIN
	//     worktree first and any worktree can mint siblings, so anchor the git
	//     calls at the first known worktree (falling back to the spawn's baked-in
	//     default cwd — the repo root the CLI was invoked from — when the list is
	//     somehow empty).
	let repoRoot: string;
	let tempWorktree: string | undefined;
	let teardown: (() => Promise<void>) | undefined;
	const abortNoHolder = (): MainHealthOutcome => ({
		healthy: false,
		defaultBranch,
		aborted: "no-default-branch-worktree",
		message:
			`no worktree has '${defaultBranch}' checked out, so there is no tree to test. ` +
			`Check it out somewhere (e.g. \`git worktree add ../${defaultBranch} ${defaultBranch}\`) and re-run.`,
		warnings: [],
		failingPackages: [],
		toolchainMissing: [],
		failingGates: [],
		elapsedMs: Date.now() - t0,
	});
	if (held) {
		repoRoot = held.worktree;
	} else {
		let tmp: string | undefined;
		try {
			tmp = await mkdtemp(path.join(os.tmpdir(), "main-health-"));
			const wt = path.join(tmp, "wt");
			const gitCwd = worktrees[0]?.worktree;
			const spawnOpts = gitCwd ? { cwd: gitCwd } : undefined;
			const added = await opts.spawn("git", ["worktree", "add", "--detach", wt, defaultBranch], spawnOpts);
			if (added.exitCode !== 0) throw new Error(added.stderr.trim() || `git worktree add exited ${added.exitCode}`);
			repoRoot = wt;
			tempWorktree = wt;
			// Best-effort teardown: remove the worktree (git prunes its metadata)
			// and then the temp dir that held it. ALWAYS runs — a thrown CI result
			// must not leave checkout litter in /tmp.
			teardown = async () => {
				try {
					await opts.spawn("git", ["worktree", "remove", "--force", wt], spawnOpts);
				} finally {
					await rm(tmp as string, { recursive: true, force: true }).catch(() => {});
				}
			};
		} catch {
			// The fallback itself failed — the honest answer is still "no tree to
			// test", i.e. the original abort. A partial add may have left files in
			// tmp; sweep them, but a failed sweep must not mask the abort.
			if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
			return abortNoHolder();
		}
	}

	try {
		// 2. Qualify the verdict BEFORE running: whatever we are about to test, say
		//    how far it is from `origin/<D>`. These never block — a dirty or stale
		//    main is still worth testing, the reader just needs to know.
		const warnings: string[] = [];
		if (tempWorktree) {
			warnings.push(
				`no worktree holds '${defaultBranch}' — ran in a throwaway worktree at ${tempWorktree} (removed after this run).`,
			);
		}
		const dirty = await client.dirtyPaths(repoRoot);
		if (dirty.length > 0) {
			warnings.push(
				`${dirty.length} uncommitted change(s) in ${repoRoot} — this verdict is about that working tree, ` +
					`not exactly ${remote}/${defaultBranch}.`,
			);
		}
		const { behind } = await client.aheadBehind(`${remote}/${defaultBranch}`, defaultBranch);
		if (behind > 0) {
			warnings.push(
				`'${defaultBranch}' is ${behind} commit(s) behind ${remote}/${defaultBranch} — sync first for a current answer.`,
			);
		}
		// Resolve the BRANCH, not "HEAD": a ref name is repo-global, so this needs no
		// cwd, and the worktree holding <D> has HEAD == <D> by definition.
		const head = await client.revParse(defaultBranch);

		// 3. Run the WHOLE matrix + the whole gate suite in that tree. `all: true` is
		//    the point: the change-scoped run is what already exists and is exactly
		//    what cannot see a package your branch does not touch.
		const runCi = opts.runCi ?? runLocalCi;
		const ci = await runCi({
			repoRoot,
			all: true,
			includeGates: true,
			spawn: opts.spawn,
			signal: opts.signal,
			readGates: opts.readGates,
			log: opts.log,
			// `all: true` makes change detection moot, but the base-ref default
			// still resolves — keep it on the configured remote.
			remoteName: remote,
		});

		// Exit 127 is the shell's "command not found" — `bun run typecheck` could not
		// find tsc because that worktree has no deps installed. Counting those as
		// "main is red" is how a health signal turns into noise nobody reads: the
		// first live run reported 7 red packages, 5 of which were just uninstalled.
		// Portability: `bun run` resolves package scripts through a shell on BOTH
		// macOS and Linux, so 127 holds on every supported platform (a direct
		// arg-array spawn of a missing binary would instead surface as spawn
		// ENOENT — the matrix rows here are all `bun run`, never direct).
		const TOOLCHAIN_MISSING = 127;
		// Lint is checked for the same reason: `biome` is a package-local binary, so
		// an uninstalled worktree fails it with 127 exactly as it fails tsc. A
		// package whose typecheck is skipped ("no tsc key") but whose lint is 127 is
		// still an uninstalled worktree, not a red branch.
		const toolchainMissing = ci.packages
			.filter((p) => p.typecheck?.exitCode === TOOLCHAIN_MISSING || p.lint?.exitCode === TOOLCHAIN_MISSING)
			.map((p) => p.name);
		// A package with no toolchain is UNVERIFIED across the board — its test is
		// meaningless too. Several matrix rows are `bun run build && …`, which fails
		// for the same missing-deps reason, so counting the test would blame the
		// branch for an uninstalled worktree.
		const missing = new Set(toolchainMissing);
		const failingPackages = ci.packages
			.filter(
				(p) =>
					!missing.has(p.name) &&
					((p.test.exitCode !== 0 && p.test.exitCode !== -1) ||
						(!!p.typecheck && !p.typecheck.skipped && p.typecheck.exitCode !== 0) ||
						(!!p.lint && !p.lint.skipped && p.lint.exitCode !== 0)),
			)
			.map((p) => p.name);
		const failingGates = ci.gates.filter((g) => g.exitCode !== 0).map((g) => g.name);

		if (toolchainMissing.length > 0) {
			warnings.push(
				`${toolchainMissing.length} package(s) could not be typechecked — no toolchain in ${repoRoot} ` +
					`(${toolchainMissing.join(", ")}). Run \`bun install\` from ${repoRoot}/bun-apps. ` +
					`These are NOT counted as failures, but they are also not verified.`,
			);
		}

		return {
			// An unrun check is not evidence of health, so 127 keeps the branch
			// unverified even if everything that DID run passed.
			healthy: ci.overall === "pass" && toolchainMissing.length === 0,
			defaultBranch,
			worktree: repoRoot,
			...(tempWorktree ? { tempWorktree } : {}),
			head,
			warnings,
			failingPackages,
			toolchainMissing,
			failingGates,
			...(ci.gateError ? { gateError: ci.gateError } : {}),
			ci,
			elapsedMs: Date.now() - t0,
		};
	} finally {
		await teardown?.();
	}
}
