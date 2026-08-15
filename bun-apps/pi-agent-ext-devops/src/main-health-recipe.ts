/**
 * runMainHealth — "is the default branch green right now?"
 *
 * WHY THIS EXISTS
 *   `local_ci` is CHANGE-SCOPED (packages touched vs origin/main) and remote CI
 *   is disabled in this repo. Together those mean a branch that happens not to
 *   touch a broken package merges green forever, and no step in the devops chain
 *   ever reports that the default branch itself is failing. On 2026-08-15 main
 *   had been red on `pi-agent` for days and had just gone red on
 *   `pi-agent-ext-obsidian`; the only way anyone found out was running the whole
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
 * DEPTH, NOT A NEW ENGINE
 *   Everything about running the suite already exists in `runLocalCi` — this
 *   adds only "which tree, and how do I qualify the answer". `runCi` is
 *   injectable so the whole flow is testable with zero git/filesystem.
 */
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
}

export interface MainHealthOutcome {
	/** True only when the suite RAN and came back green. Never true on an abort. */
	healthy: boolean;
	defaultBranch: string;
	/** Absolute path of the worktree the suite ran in (absent on abort). */
	worktree?: string;
	/** The commit actually tested (absent on abort). */
	head?: string;
	/** Set when nothing ran. `healthy` is then false. */
	aborted?: "no-default-branch-worktree";
	/** Human-readable reason, present whenever `aborted` is. */
	message?: string;
	/** Caveats about WHAT was tested — a dirty or behind tree. Never a failure. */
	warnings: string[];
	/** Packages whose test or (non-skipped) typecheck genuinely failed. */
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
	/** Carried up from local_ci when the gate job itself could not be read. */
	gateError?: string;
	/** The full underlying outcome, for callers that want the detail. */
	ci?: CiOutcome;
	elapsedMs: number;
}

export async function runMainHealth(opts: MainHealthOptions): Promise<MainHealthOutcome> {
	const t0 = Date.now();
	const { client } = opts;
	const defaultBranch = (await client.defaultBranch()) || "main";

	// 1. Find the worktree holding <D>. A detached worktree holds no branch, so
	//    `branch` is undefined there and can never match.
	const worktrees = await client.worktreeList();
	const held = worktrees.find((w) => w.branch === defaultBranch);
	if (!held) {
		return {
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
		};
	}
	const repoRoot = held.worktree;

	// 2. Qualify the verdict BEFORE running: whatever we are about to test, say
	//    how far it is from `origin/<D>`. These never block — a dirty or stale
	//    main is still worth testing, the reader just needs to know.
	const warnings: string[] = [];
	const dirty = await client.dirtyPaths(repoRoot);
	if (dirty.length > 0) {
		warnings.push(
			`${dirty.length} uncommitted change(s) in ${repoRoot} — this verdict is about that working tree, ` +
				`not exactly origin/${defaultBranch}.`,
		);
	}
	const { behind } = await client.aheadBehind(`origin/${defaultBranch}`, defaultBranch);
	if (behind > 0) {
		warnings.push(
			`'${defaultBranch}' is ${behind} commit(s) behind origin/${defaultBranch} — sync first for a current answer.`,
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
	});

	// Exit 127 is the shell's "command not found" — `bun run typecheck` could not
	// find tsc because that worktree has no deps installed. Counting those as
	// "main is red" is how a health signal turns into noise nobody reads: the
	// first live run reported 7 red packages, 5 of which were just uninstalled.
	const TOOLCHAIN_MISSING = 127;
	const toolchainMissing = ci.packages
		.filter((p) => p.typecheck?.exitCode === TOOLCHAIN_MISSING)
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
					(!!p.typecheck && !p.typecheck.skipped && p.typecheck.exitCode !== 0)),
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
		head,
		warnings,
		failingPackages,
		toolchainMissing,
		failingGates,
		...(ci.gateError ? { gateError: ci.gateError } : {}),
		ci,
		elapsedMs: Date.now() - t0,
	};
}
