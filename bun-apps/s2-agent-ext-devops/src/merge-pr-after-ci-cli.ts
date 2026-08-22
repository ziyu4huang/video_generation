#!/usr/bin/env bun
/**
 * merge-pr-after-ci-cli — the bash-callable entry point for finishing a PR
 * (bin `devops-merge-pr-after-ci`): preflight → local-CI gate → merge gates →
 * squash-merge → verify-merge → branch cleanup, in one throw-free wrapper.
 *
 * WHY THIS EXISTS (bash → TS port):
 *   `scripts/pr-finish.sh` polled remote GitHub Actions CI before merging.
 *   Remote CI is intentionally disabled in this repo (see CLAUDE.md), so that
 *   waiting was dead code; LOCAL CI (`runLocalCi`) is the real gate. This port
 *   composes the existing devops recipes (`ci-recipe`, `gh`, `verify-merge-
 *   recipe`) behind a thin argv wrapper — same pattern as `src/sync-default-branch-cli.ts`:
 *   all logic stays in the recipes; this file only parses argv, sequences the
 *   steps, and serializes the outcome. Nothing is reimplemented here.
 *
 * CONTRACT
 *   - `<pr-number>` (or `--pr <n>`)  required
 *   - `--dry-run`                    run the read-only gates (preflight /
 *                                   prStatus / local-CI), emit the PLANNED
 *                                   commands, mutate nothing
 *   - `--expected-scope <glob>`      repeatable; passed to verify_merge_landed
 *   - `--keep-branch`                skip branch deletion + prune after merge
 *   - `--assume-ci-green <sha>`      skip the local-CI gate, asserting <sha>
 *                                   was already verified green; aborts unless
 *                                   it equals the PR's CURRENT head oid
 *   - `--repo-root <path>`           default: the repo this file lives in
 *   - `--help` / `-h`                usage (exit 0)
 *   - stdout: the structured outcome as JSON (nothing else on stdout)
 *   - exit 0 on success (incl. dry-run); exit 1 on abort (dirty_tree /
 *     local_ci_failed / not-open / behind / not-clean / missing-workflow-scope
 *     / ci-assumption-stale / ...); exit 2 on a usage error. Throw-free: every
 *     failure is a structured `aborted`.
 *
 * THE SNAPSHOT THE MERGE GATES READ MUST BE FRESH.
 *   The merge gates (OPEN / not-BEHIND / CLEAN) used to be evaluated against
 *   the preflight `prStatus` snapshot — taken BEFORE a run_local_ci run that
 *   routinely takes two minutes. Both directions were wrong: a `mergeState`
 *   of UNKNOWN (GitHub computes mergeability asynchronously; UNKNOWN means
 *   "not computed yet", NOT "cannot merge") aborted a PR that had settled to
 *   CLEAN long before the gate ran, and a CLEAN snapshot could go stale in
 *   the same window (main moves fast in this repo). The gates now read a
 *   snapshot taken AFTER the CI gate, and an UNKNOWN one is polled until it
 *   settles instead of being treated as a verdict.
 */
import path from "node:path";
import { runLocalCi, summarizeCiFailures, type CiOutcome } from "./ci-recipe.js";
import { createBranchClient } from "./gh.js";
import { selectForgeClientCached } from "./forge/select.js";
import type { GhClient } from "./recipe.js";
import type { BranchClient } from "./branch-recipe.js";
import { runVerifyMerge, type VerifyMergeOutcome } from "./verify-merge-recipe.js";
import { createLiveSpawn, type SpawnFn } from "./spawn.js";

export interface PrFinishCliResult {
	exitCode: number;
	/** Exactly what belongs on stdout (empty on a usage error / --help). */
	stdout: string;
	/** Diagnostics / usage — never mixed into stdout. */
	stderr: string;
}

export const PR_FINISH_CLI_USAGE = [
	"usage: merge-pr-after-ci-cli.ts <pr-number> [--dry-run] [--expected-scope <glob>]...",
	"                         [--keep-branch] [--assume-ci-green <sha>]",
	"                         [--repo-root <path>]",
	"",
	"Finishes a PR: preflight (clean tree + pr status) → local-CI gate →",
	"merge gates (OPEN + not-BEHIND + CLEAN, read from a FRESH pr status) →",
	"squash-merge → verify_merge_landed → branch cleanup (delete local+remote head",
	"branch, fetch --prune). Local CI is the gate (remote CI waiting is",
	"intentionally NOT ported). Prints the structured outcome as JSON on",
	"stdout. Exit 0 on success (incl. dry-run), 1 on abort, 2 on usage error.",
	"Options:",
	"  --pr <n>               PR number (same as the positional form)",
	"  --dry-run              run read-only gates, emit planned commands only",
	"  --expected-scope <g>   repeatable; scope entry: x/** any depth, x/* one segment, x/ prefix, bare x exact-or-dir",
	"  --keep-branch          skip post-merge branch deletion + prune",
	"  --assume-ci-green <sha>  skip local CI, asserting <sha> was already",
	"                         verified green; aborts unless it equals the PR's",
	"                         current head oid (a retry shortcut, never a way",
	"                         to merge something local CI has not seen)",
	"  --repo-root <path>     default: the repo this file lives in",
].join("\n");

// defaultRepoRoot is shared plumbing — single definition in src/cli-common.ts,
// re-exported here for import stability.
import { defaultRepoRoot } from "./cli-common.js";
export { defaultRepoRoot };

/** Parsed argv. */
export interface ParsedPrFinishArgs {
	pr: number;
	dryRun: boolean;
	expectedScope: string[];
	keepBranch: boolean;
	repoRoot?: string;
	/** Lowercased 40-hex head oid the caller already verified green, if given. */
	assumeCiGreen?: string;
}

/** A full 40-hex git object id (what `gh pr view --json headRefOid` returns).
 *  Abbreviations are rejected on purpose: the assertion is only worth anything
 *  if it can be compared byte-for-byte against the PR's current head. */
const FULL_SHA = /^[0-9a-f]{40}$/;

/** Pure argv → flags (or a usage-error message). Exported for tests. */
export function parsePrFinishArgs(argv: string[]): { ok: true; args: ParsedPrFinishArgs } | { ok: false; message: string } {
	let pr: number | undefined;
	let dryRun = false;
	let expectedScope: string[] = [];
	let keepBranch = false;
	let repoRoot: string | undefined;
	let assumeCiGreen: string | undefined;

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--dry-run") {
			dryRun = true;
		} else if (a === "--keep-branch") {
			keepBranch = true;
		} else if (a === "--pr") {
			const v = argv[++i];
			const n = Number.parseInt(v ?? "", 10);
			if (!Number.isFinite(n) || n <= 0) {
				return { ok: false, message: `--pr needs a positive PR number (got ${JSON.stringify(v ?? "missing")})` };
			}
			pr = n;
		} else if (a === "--expected-scope") {
			const v = argv[++i];
			if (v === undefined || v === "") {
				return { ok: false, message: "--expected-scope needs a value" };
			}
			// Comma-split to match verify-merge-cli's --scope syntax. The two
			// flags diverged silently and a comma list passed here became ONE
			// literal entry matching nothing — every file out-of-scope, a false
			// CONTAMINATED on an intentional merge (PR #1808, 2026-08-22).
			expectedScope.push(...v.split(",").map((s) => s.trim()).filter(Boolean));
		} else if (a === "--assume-ci-green") {
			const v = argv[++i];
			if (v === undefined || v === "") {
				return { ok: false, message: "--assume-ci-green needs a 40-hex head sha" };
			}
			const sha = v.toLowerCase();
			if (!FULL_SHA.test(sha)) {
				return { ok: false, message: `--assume-ci-green needs a full 40-hex sha (got ${JSON.stringify(v)})` };
			}
			assumeCiGreen = sha;
		} else if (a === "--repo-root") {
			const v = argv[++i];
			if (v === undefined) {
				return { ok: false, message: "--repo-root needs a value" };
			}
			repoRoot = v;
		} else if (a === "-h" || a === "--help") {
			return { ok: false, message: "" }; // handled by caller via exitCode 0
		} else if (a.startsWith("-")) {
			return { ok: false, message: `unknown flag: ${a}` };
		} else {
			const n = Number.parseInt(a, 10);
			if (!Number.isFinite(n) || n <= 0 || String(n) !== a) {
				return { ok: false, message: `expected a PR number, got: ${a}` };
			}
			if (pr !== undefined) {
				return { ok: false, message: `PR number given twice (${pr} and ${a})` };
			}
			pr = n;
		}
	}

	if (pr === undefined) {
		return { ok: false, message: "missing required <pr-number> (positional or --pr <n>)" };
	}
	return { ok: true, args: { pr, dryRun, expectedScope, keepBranch, repoRoot, assumeCiGreen } };
}

/** The structured outcome serialized on stdout. */
export interface PrFinishOutcome {
	pr: number;
	merged: boolean;
	verdict: VerifyMergeOutcome["verdict"];
	branchSpent: boolean;
	/** Every spawned command, plus the planned ones in dry-run. */
	commands: string[];
	warnings: string[];
	dryRun?: boolean;
	/** Present ONLY when `--assume-ci-green` skipped the local-CI gate. Its
	 *  absence is the proof that this invocation ran CI itself. */
	ciSkipped?: { assumedSha: string };
	/** How the pre-merge `mergeState` was reached: the settled value and how
	 *  many `gh pr view` calls it took. `polls > 1` means it started UNKNOWN. */
	mergeStateSettle?: { mergeState: string; polls: number };
	aborted?: { aborted: true; reason: string; message: string };
}

/** How many times a `mergeState` of UNKNOWN is re-read before it is believed. */
export const MERGE_STATE_POLLS = 4;
/** Delay between those re-reads. */
export const MERGE_STATE_POLL_DELAY_MS = 3000;

type PrStatusSnapshot = Awaited<ReturnType<GhClient["prStatus"]>>;

/**
 * Read `prStatus` until `mergeState` is something other than UNKNOWN.
 *
 * UNKNOWN is not a verdict — it is GitHub saying it has not finished computing
 * mergeability yet (it recomputes on every push to the PR and on every push to
 * its base). Treating it as "not mergeable" turned a routine merge into a
 * manual poll-and-retry loop, at the cost of a full run_local_ci re-run each time.
 * Anything else — CLEAN, BEHIND, DIRTY, BLOCKED — is a real answer and returns
 * immediately, so the common path costs exactly one `gh pr view`.
 */
/**
 * Pure decision for the version-bump advisory: warn iff the merge touched
 * `bun-apps/s2-agent/**` AND package.json's version is identical base→head.
 * Null on any unreadable input — an advisory must stay silent when its facts
 * are missing, not manufacture noise. Exported for unit tests.
 */
export function versionNudge(
	files: Array<{ path: string }>,
	headPkgRaw: string | null,
	basePkgRaw: string | null,
): string | null {
	if (!headPkgRaw || !basePkgRaw) return null;
	const touched = files.filter((f) => f.path.startsWith("bun-apps/s2-agent/"));
	if (touched.length === 0) return null;
	let head: string | undefined;
	let base: string | undefined;
	try {
		head = (JSON.parse(headPkgRaw) as { version?: string }).version;
		base = (JSON.parse(basePkgRaw) as { version?: string }).version;
	} catch {
		return null;
	}
	if (!head || !base || head !== base) return null;
	return (
		`s2-agent changed (${touched.length} file(s)) but its version was not bumped (still ${head}). ` +
		`Run \`bun bun-apps/s2-agent-ext-devops/src/version-bump-cli.ts --package s2-agent --patch\` ` +
		`(or --minor / --major as judged) and include the bump in the PR — advisory, not a block. ` +
		`Deploy version dirs render <pkgVersion>+g<sha>; an ever-frozen 0.1.0 prefix names nothing.`
	);
}

/** Read the two package.json blobs for the nudge; null on any git failure. */
async function computeVersionNudge(opts: {
	spawn: (cmd: string, args: string[], o?: { cwd?: string }) => Promise<{ stdout: string; exitCode: number }>;
	repoRoot: string;
	files: Array<{ path: string }>;
	mergeSha?: string;
	baseRef: string;
}): Promise<string | null> {
	if (!opts.mergeSha) return null;
	const showPkg = async (ref: string): Promise<string | null> => {
		try {
			const r = await opts.spawn("git", ["-C", opts.repoRoot, "show", `${ref}:bun-apps/s2-agent/package.json`]);
			return r.exitCode === 0 ? r.stdout : null;
		} catch {
			return null;
		}
	};
	const [headRaw, baseRaw] = await Promise.all([showPkg(opts.mergeSha), showPkg(opts.baseRef)]);
	return versionNudge(opts.files, headRaw, baseRaw);
}

export async function settlePrStatus(
	gh: GhClient,
	pr: number,
	sleep: (ms: number) => Promise<void>,
	polls: number = MERGE_STATE_POLLS,
	delayMs: number = MERGE_STATE_POLL_DELAY_MS,
): Promise<{ status: PrStatusSnapshot; polls: number }> {
	let status = await gh.prStatus(pr);
	let used = 1;
	while (status.mergeState === "UNKNOWN" && used < polls) {
		await sleep(delayMs);
		status = await gh.prStatus(pr);
		used++;
	}
	return { status, polls: used };
}

/** Injectable seams (`gh`, `client`, `spawn`, `repoRoot`, `runCi`, `verify`) for tests. */
export interface PrFinishDeps {
	gh?: GhClient;
	client?: BranchClient;
	spawn?: SpawnFn;
	repoRoot?: string;
	/** Defaults to the real `runLocalCi`; tests stub it (offline). */
	runCi?: (opts: Parameters<typeof runLocalCi>[0]) => Promise<CiOutcome>;
	/**
	 * The verification step. Injectable ONLY so the catch around it is testable:
	 * runVerifyMerge is throw-free today, which is exactly why that catch could
	 * fabricate a `verdict: "CLEAN"` for years without anyone noticing.
	 */
	verify?: typeof runVerifyMerge;
	/** Injectable so the UNKNOWN-poll path is testable without real waiting. */
	sleep?: (ms: number) => Promise<void>;
	/** Remote name for `origin/<base>` probes, the planned delete, and the
	 *  post-merge detach fallback (default: the forge selection's resolution,
	 *  else `origin`). */
	remoteName?: string;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The one command that fixes a missing `workflow` scope. */
export const WORKFLOW_SCOPE_FIX = "gh auth refresh -h github.com -s workflow";

/**
 * Is this merge failure the missing-`workflow`-scope refusal?
 *
 * GitHub refuses `mergePullRequest` for an OAuth app without the `workflow`
 * scope whenever the PR's diff touches `.github/workflows/` — classified by
 * PATH, so `ci.yml.disabled` counts even though nothing runs it. This repo's
 * gate work lives in that file, so it recurs; and the scope is not stable
 * across a session (observed 2026-08-18: one such PR merged, another was
 * refused ~90 minutes later on the same account).
 *
 * It arrived as a raw GraphQL passthrough inside a generic `merge-failed`,
 * which says nothing about what to do. It is a distinct, recoverable class
 * with exactly one fix, so it gets its own reason and carries that fix.
 */
export function isMissingWorkflowScope(message: string): boolean {
	return /without\s+[`'"]?workflow[`'"]?\s+scope/i.test(message) || /refusing to allow an? .*to (?:create or update|update) workflow/i.test(message);
}

/** Wrap a SpawnFn so every invocation is recorded (rendered runnable).
 * NB: options (cwd) MUST be forwarded — dropping it makes every spawn run_local_ci
 * makes on pr-finish's behalf run at the baked-in default cwd (repo root), so
 * package tests and gate commands fail while the same run_local_ci passes
 * standalone (observed 2026-08-15: 9 gates + the package row red inside
 * pr-finish, green directly). */
/** Render a spawn as a runnable shell string — the `git -C <dir> …` form the
 *  recipes record. A git invocation that carries a cwd gets it hoisted into a
 *  quoted `-C "<dir>"` prefix; one whose dir is already baked into the args
 * (recipes spawn `git -C <dir> …` directly) is already runnable as the plain
 *  join; non-git spawns (bun, gh, echo, …) keep the plain join too. */
function renderRecorded(cmd: string, args: string[], cwd?: string): string {
	if (cmd === "git" && cwd) return `git -C "${cwd}" ${args.join(" ")}`;
	return [cmd, ...args].join(" ");
}

function recordingSpawn(spawn: SpawnFn): { fn: SpawnFn; commands: string[] } {
	const commands: string[] = [];
	const fn: SpawnFn = async (cmd, args, options) => {
		commands.push(renderRecorded(cmd, args, options?.cwd));
		return spawn(cmd, args, options);
	};
	return { fn, commands };
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Read `fn`; a throw becomes a warning + `fallback` (cleanup must never abort a done merge). */
async function safeRead<T>(fn: () => Promise<T>, fallback: T, label: string, warnings: string[]): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		warnings.push(`${label} read failed: ${errMsg(err)}`);
		return fallback;
	}
}

/**
 * The path of a DIFFERENT worktree holding `branch`, or undefined when no other
 * worktree has it. `repoRoot` (ours) is excluded on purpose: we can detach our
 * own HEAD, but another worktree's checkout is not ours to move.
 */
async function ownerWorktreeOf(
	client: Pick<BranchClient, "worktreeList">,
	branch: string,
	repoRoot: string,
	warnings: string[],
): Promise<string | undefined> {
	const list = await safeRead(() => client.worktreeList(), [], "worktreeList", warnings);
	const norm = (p: string) => path.resolve(p);
	const mine = norm(repoRoot);
	return list.find((w) => w.branch === branch && norm(w.worktree) !== mine)?.worktree;
}

/**
 * Pure argv → result. `gh` / `client` / `spawn` / `runCi` / `verify` are injectable so
 * tests never touch a real repo or a real gh; the live entry point below
 * supplies the real set (the same wiring extensions/devops.ts uses).
 */
export async function runPrFinishCli(argv: string[], deps: PrFinishDeps = {}): Promise<PrFinishCliResult> {
	const parsed = parsePrFinishArgs(argv);
	if (!parsed.ok) {
		// --help: usage on stderr with exit 0 (matches sync-default-branch-cli).
		if (argv.includes("-h") || argv.includes("--help")) {
			return { exitCode: 0, stdout: "", stderr: PR_FINISH_CLI_USAGE };
		}
		return { exitCode: 2, stdout: "", stderr: `${parsed.message}\n${PR_FINISH_CLI_USAGE}` };
	}
	const { pr, dryRun, expectedScope, keepBranch, assumeCiGreen } = parsed.args;
	const repoRoot = parsed.args.repoRoot ?? deps.repoRoot ?? defaultRepoRoot();

	const recorded = recordingSpawn(deps.spawn ?? createLiveSpawn(repoRoot));
	const spawn = recorded.fn;
	// Forge selection is recorded like every other spawn (gh auth token /
	// gh --version probes show up in `commands`); tests inject deps.gh directly
	// and never reach the selector.
	// The selection's resolved remote name (DEVOPS_REMOTE > git config
	// devops.remote > origin) is reused everywhere below instead of
	// re-resolving through the recording spawn (a second recorded probe).
	let gh: GhClient;
	let remoteName: string;
	if (deps.gh) {
		gh = deps.gh;
		remoteName = deps.remoteName ?? "origin";
	} else {
		const forgeSel = await selectForgeClientCached({ spawn, repoRoot });
		gh = forgeSel.client;
		remoteName = deps.remoteName ?? forgeSel.remoteName;
	}
	const client = deps.client ?? createBranchClient(spawn, remoteName);
	const runCi = deps.runCi ?? runLocalCi;
	const verifyMerge = deps.verify ?? runVerifyMerge;
	const sleep = deps.sleep ?? realSleep;

	const commands = recorded.commands;
	const warnings: string[] = [];
	// Filled in as the run progresses so an ABORT reports them too — a
	// not-clean abort is far easier to act on when it says how many polls the
	// mergeState survived.
	let ciSkipped: PrFinishOutcome["ciSkipped"];
	let mergeStateSettle: PrFinishOutcome["mergeStateSettle"];
	const abort = (reason: string, message: string): PrFinishCliResult => {
		const outcome: PrFinishOutcome = {
			pr,
			merged: false,
			verdict: "NOT-MERGED",
			branchSpent: false,
			commands,
			warnings,
			...(dryRun ? { dryRun: true } : {}),
			...(ciSkipped ? { ciSkipped } : {}),
			...(mergeStateSettle ? { mergeStateSettle } : {}),
			aborted: { aborted: true, reason, message },
		};
		return { exitCode: 1, stdout: JSON.stringify(outcome, null, 2), stderr: "" };
	};

	// --- 1. Preflight: clean tree + PR status. -------------------------------
	let clean = false;
	try {
		clean = await client.isClean(repoRoot);
	} catch (err) {
		warnings.push(`isClean failed: ${errMsg(err)}`);
	}
	if (!clean) {
		let dirty: string[] = [];
		try {
			dirty = await client.dirtyPaths(repoRoot);
		} catch {
			// best-effort detail only
		}
		return abort("dirty_tree", `working tree not clean at ${repoRoot}${dirty.length ? ` (dirty: ${dirty.join(", ")})` : ""} — commit or stash first`);
	}

	// This snapshot supplies the REF NAMES the CI gate needs to scope its diff.
	// It is deliberately NOT what the merge gates read — by the time they run,
	// a run_local_ci pass has elapsed and this is stale (see the header note).
	let status: PrStatusSnapshot;
	try {
		status = await gh.prStatus(pr);
	} catch (err) {
		return abort("pr-status-failed", `gh.prStatus(${pr}) failed: ${errMsg(err)}`);
	}

	// --- 2. Local-CI gate (remote-CI waiting intentionally NOT ported). ------
	let ci: CiOutcome | undefined;
	if (assumeCiGreen) {
		// The gate is not run here; the caller asserts it already passed for a
		// specific commit. That assertion is checked against the PR's current
		// head below, once the fresh snapshot is in hand — asserting against
		// THIS snapshot would let a push landing during the gap slip through.
		ciSkipped = { assumedSha: assumeCiGreen };
		warnings.push(
			`run_local_ci SKIPPED — --assume-ci-green ${assumeCiGreen} asserts it already passed for that commit. ` +
				`This invocation did not run the gate.`,
		);
	} else {
		try {
			// Base the run_local_ci diff at the PR base's REMOTE-TRACKING ref, not the
			// local base branch. In this repo's multi-worktree layout `main` is
			// checked out in another worktree and the local ref cannot be
			// fast-forwarded here — a stale local `main` sweeps every commit since
			// into the diff and over-scopes run_local_ci to the whole matrix (observed
			// 318 s vs 69 s for the same branch). Fall back to the plain base name
			// when the tracking ref doesn't resolve (fresh clone, no fetch yet).
			const originBase = `${remoteName}/${status.baseRefName}`;
			const probe = await spawn("git", ["rev-parse", "--verify", "-q", originBase], { cwd: repoRoot });
			const ciBase = probe.exitCode === 0 ? originBase : status.baseRefName;
			// `log` MUST be forwarded, for the same reason `cwd` must (see the note on
			// the spawn seam below): runSchemaCostCheck is IMPORTED, so without a sink
			// its human-readable banner goes to this process's stdout via console.log —
			// and stdout here is the JSON payload this CLI's own contract promises is
			// "exactly what belongs on stdout". Dropping it emitted an unparseable
			// outcome whenever the schema-cost baseline had drifted.
			ci = await runCi({
				repoRoot,
				baseRef: ciBase,
				headRef: status.headRefName,
				spawn,
				log: (line: string) => process.stderr.write(`${line}\n`),
			});
		} catch (err) {
			return abort("local_ci_failed", `local CI threw: ${errMsg(err)}`);
		}
		if (ci.overall !== "pass") {
			return abort(
				"local_ci_failed",
				`local CI ${ci.overall} for ${status.baseRefName}..${status.headRefName} (${ci.elapsedMs}ms) — failing: ${summarizeCiFailures(ci)} — fix before merging`,
			);
		}
		// ≤5-minute budget (house rule): advisory, never blocks the merge — but it
		// must be LOUD, because a slow run_local_ci stops being used as a gate.
		if (ci.overBudget) {
			const slowest = (ci.slowest ?? [])
				.map((s) => `${s.name} ${(s.durationMs / 1000).toFixed(1)}s`)
				.join(", ");
			warnings.push(
				`run_local_ci took ${(ci.elapsedMs / 1000).toFixed(0)}s (budget ${(ci.budgetMs / 1000).toFixed(0)}s) — ` +
					`over-budget CI is bad CI; optimize before the next run. Slowest: ${slowest || "n/a"}`,
			);
		}
	}

	// --- 3. Merge gates, read from a FRESH snapshot. --------------------------
	// Re-read AFTER the CI gate: the preflight snapshot is minutes old by now,
	// and an UNKNOWN mergeState is polled rather than believed (header note).
	try {
		const settled = await settlePrStatus(gh, pr, sleep);
		status = settled.status;
		mergeStateSettle = { mergeState: settled.status.mergeState, polls: settled.polls };
		if (settled.polls > 1) {
			warnings.push(
				`mergeState was UNKNOWN and settled to ${settled.status.mergeState} after ${settled.polls} reads — ` +
					`GitHub computes mergeability asynchronously.`,
			);
		}
	} catch (err) {
		return abort("pr-status-failed", `gh.prStatus(${pr}) re-read failed: ${errMsg(err)}`);
	}

	// The CI assertion is checked against the FRESH head: if anything was
	// pushed to the PR after the caller ran CI, the sha no longer matches and
	// this aborts instead of merging a commit no gate has seen.
	if (assumeCiGreen) {
		const head = status.headRefOid?.toLowerCase();
		if (!head) {
			return abort(
				"ci-assumption-unverifiable",
				`--assume-ci-green was given but PR #${pr} reports no headRefOid — the assertion cannot be checked, so it is not accepted`,
			);
		}
		if (head !== assumeCiGreen) {
			return abort(
				"ci-assumption-stale",
				`--assume-ci-green ${assumeCiGreen} does not match PR #${pr}'s current head ${head} — re-run local CI against the new head`,
			);
		}
	}

	if (status.state !== "OPEN") {
		return abort("not-open", `PR #${pr} state is ${status.state}, expected OPEN`);
	}
	if (status.mergeState === "BEHIND") {
		return abort("behind", `PR #${pr} is BEHIND ${status.baseRefName} — run prepare_feature_branch (rebase) first`);
	}
	if (status.mergeState !== "CLEAN") {
		return abort("not-clean", `PR #${pr} mergeState is ${status.mergeState}, expected CLEAN`);
	}

	// --- dry-run stops here: emit the planned commands, mutate nothing. ------
	if (dryRun) {
		const planned = [`gh pr merge ${pr} --squash`];
		if (!keepBranch && status.headRefName) {
			planned.push(`git branch -D ${status.headRefName}`);
			planned.push(`git push ${remoteName} --delete ${status.headRefName}`);
		}
		if (!keepBranch) planned.push("git fetch --prune");
		const outcome: PrFinishOutcome = {
			pr,
			merged: false,
			verdict: "NOT-MERGED",
			branchSpent: false,
			commands: [...commands, ...planned],
			warnings,
			dryRun: true,
			...(ciSkipped ? { ciSkipped } : {}),
			...(mergeStateSettle ? { mergeStateSettle } : {}),
		};
		return { exitCode: 0, stdout: JSON.stringify(outcome, null, 2), stderr: "" };
	}

	// --- 4. Merge (squash; branch deletion is our own cleanup below). --------
	try {
		await gh.mergeNow(pr, "squash", false);
	} catch (err) {
		const message = errMsg(err);
		if (isMissingWorkflowScope(message)) {
			return abort(
				"missing-workflow-scope",
				`gh pr merge ${pr} --squash was refused: the gh token has no \`workflow\` scope, and this PR ` +
					`touches .github/workflows/. Fix: ${WORKFLOW_SCOPE_FIX} (interactive — the token owner must run it), ` +
					`then re-run with --assume-ci-green <head sha> to skip re-paying for local CI. ` +
					`Original: ${message}`,
			);
		}
		return abort("merge-failed", `gh pr merge ${pr} --squash failed: ${message}`);
	}
	// The merge advanced ${baseRefName} on origin — the worktree holding the
	// default branch (possibly this cwd) is now behind until synced. Nudge the
	// caller (matches sync_default_branch's own behind-default warning style).
	warnings.push(
		`PR #${pr} merged into ${status.baseRefName} — the default-branch worktree / this cwd may now be behind ${remoteName}/${status.baseRefName}; run sync_default_branch to catch up.`,
	);

	// --- 5. Verify (read-only; CONTAMINATED warns, never rolls back). -------
	let verify: VerifyMergeOutcome;
	try {
		// allowFetch: we just merged, so the squash commit is on the remote and
		// not yet in the local object store — without the fetch this verification
		// could not read a single file. (pr_finish already mutates; the fetch
		// touches the object store only.)
		verify = await verifyMerge({ gh, client, spawn, repoRoot, pr, expectedScope, allowFetch: true, remoteName });
	} catch (err) {
		// This used to synthesize `verdict: "CLEAN"`. A total failure of the
		// verification step reported itself as a verified-clean merge — the same
		// launder-failure-into-success bug as issue #1439, one layer up.
		verify = {
			pr,
			state: "MERGED",
			merged: true,
			verdict: "UNVERIFIED",
			files: [],
			fileCount: 0,
			insertions: 0,
			deletions: 0,
			outOfScope: [],
			inspected: false,
			branchSpent: false,
			commands: [],
			warnings: [`runVerifyMerge threw: ${errMsg(err)}`],
		};
	}
	warnings.push(...verify.warnings);
	if (verify.aborted) {
		warnings.push(`verify_merge_landed aborted (${verify.aborted.reason}): ${verify.aborted.message}`);
	}
	if (verify.verdict === "CONTAMINATED") {
		warnings.push(
			`CONTAMINATED merge: ${verify.outOfScope.length} out-of-scope file(s): ${verify.outOfScope.map((f) => f.path).join(", ")} — NOT rolled back`,
		);
	}
	if (verify.verdict === "UNVERIFIED") {
		warnings.push(
			`UNVERIFIED merge: PR #${pr} merged but its file scope could NOT be checked — treat the scope as unknown, not as clean.`,
		);
	}

	// --- 5b. Advisory: s2-agent changed without a version bump. -------------
	// Version policy (2026-08-22): bumps are MANUAL at PR finish via
	// version-bump-cli.ts. This nudge fires when the merge touched
	// bun-apps/s2-agent/** yet package.json's version is identical base→head.
	// Advisory only (schema-cost precedent) — never blocks, never fails.
	{
		const nudge = await computeVersionNudge({
			spawn,
			repoRoot,
			files: verify.files,
			mergeSha: verify.mergeSha,
			baseRef: `${remoteName}/${status.baseRefName}`,
		});
		if (nudge) warnings.push(nudge);
	}

	// --- 6. Cleanup: delete the spent head branch, prune (unless kept). ------
	const headRefName = status.headRefName;
	if (!keepBranch) {
		if (verify.branchSpent && headRefName) {
			// Git refuses `branch -D` on a branch checked out in ANY worktree, and
			// the worktree that just ran the merge is normally still sitting on the
			// head branch — so this step failed on essentially every run and the
			// caller had to detach and sweep by hand. Detach HERE first; a branch
			// held by a DIFFERENT worktree is left alone (that tree is not ours to
			// move) and reported as such instead of as a bare git error.
			//
			// Safe by construction: preflight already gated on a clean tree, and we
			// only reach this when verify said the branch is spent — its commits are
			// all in the merge, so detaching onto it loses nothing.
			const heldElsewhere = await ownerWorktreeOf(client, headRefName, repoRoot, warnings);
			if (heldElsewhere) {
				warnings.push(
					`local branch '${headRefName}' is checked out in another worktree (${heldElsewhere}) — left in place; delete it from there.`,
				);
			} else {
				const current = await safeRead(() => client.currentBranch(), undefined, "currentBranch", warnings);
				if (current === headRefName) {
					// Prefer the MERGE COMMIT over `origin/<base>`. The local
					// remote-tracking ref still points at the PRE-merge tip here —
					// `fetchPrune()` runs after this block — so detaching onto it left
					// the worktree one commit behind the merge it had just made, and the
					// caller had to check out again by hand. The merge sha is the commit
					// we actually want, and verify has already guaranteed it is in the
					// local object store (it read the diff out of it, fetching first if
					// needed). Fall back to `origin/<base>` only when verify could not
					// inspect — there the sha may genuinely not be local.
					const onto = verify.inspected && verify.mergeSha ? verify.mergeSha : `${remoteName}/${status.baseRefName}`;
					try {
						await client.detachHead(onto);
						commands.push(`git -C "${repoRoot}" checkout --detach ${onto}`);
					} catch (err) {
						warnings.push(`detachHead(${onto}) failed: ${errMsg(err)} — local branch delete will be skipped`);
					}
				}
				try {
					await client.deleteLocalBranch(headRefName);
				} catch (err) {
					warnings.push(`deleteLocalBranch(${headRefName}) failed: ${errMsg(err)}`);
				}
			}
			try {
				await client.deleteRemoteBranch(headRefName);
			} catch (err) {
				warnings.push(`deleteRemoteBranch(${headRefName}) failed: ${errMsg(err)}`);
			}
		}
		try {
			await client.fetchPrune();
		} catch (err) {
			warnings.push(`fetchPrune failed: ${errMsg(err)}`);
		}
	}

	const outcome: PrFinishOutcome = {
		pr,
		merged: verify.merged,
		verdict: verify.verdict,
		branchSpent: verify.branchSpent,
		commands,
		warnings,
		...(ciSkipped ? { ciSkipped } : {}),
		...(mergeStateSettle ? { mergeStateSettle } : {}),
	};
	return { exitCode: 0, stdout: JSON.stringify(outcome, null, 2), stderr: "" };
}

if (import.meta.main) {
	const res = await runPrFinishCli(Bun.argv.slice(2));
	if (res.stderr) process.stderr.write(`${res.stderr}\n`);
	if (res.stdout) process.stdout.write(`${res.stdout}\n`);
	process.exit(res.exitCode);
}
