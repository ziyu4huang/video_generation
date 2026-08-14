#!/usr/bin/env bun
/**
 * pr-finish-cli — the bash-callable entry point for finishing a PR
 * (bin `devops-pr-finish`): preflight → local-CI gate → merge gates →
 * squash-merge → verify-merge → branch cleanup, in one throw-free wrapper.
 *
 * WHY THIS EXISTS (bash → TS port):
 *   `scripts/pr-finish.sh` polled remote GitHub Actions CI before merging.
 *   Remote CI is intentionally disabled in this repo (see CLAUDE.md), so that
 *   waiting was dead code; LOCAL CI (`runLocalCi`) is the real gate. This port
 *   composes the existing devops recipes (`ci-recipe`, `gh`, `verify-merge-
 *   recipe`) behind a thin argv wrapper — same pattern as `src/sync-cli.ts`:
 *   all logic stays in the recipes; this file only parses argv, sequences the
 *   steps, and serializes the outcome. Nothing is reimplemented here.
 *
 * CONTRACT
 *   - `<pr-number>` (or `--pr <n>`)  required
 *   - `--dry-run`                    run the read-only gates (preflight /
 *                                   prStatus / local-CI), emit the PLANNED
 *                                   commands, mutate nothing
 *   - `--expected-scope <glob>`      repeatable; passed to verify_merge
 *   - `--keep-branch`                skip branch deletion + prune after merge
 *   - `--repo-root <path>`           default: the repo this file lives in
 *   - `--help` / `-h`                usage (exit 0)
 *   - stdout: the structured outcome as JSON (nothing else on stdout)
 *   - exit 0 on success (incl. dry-run); exit 1 on abort (dirty_tree /
 *     local_ci_failed / not-open / behind / not-clean / ...); exit 2 on a
 *     usage error. Throw-free: every failure is a structured `aborted`.
 */
import path from "node:path";
import { runLocalCi, type CiOutcome } from "./ci-recipe.js";
import { createGhClient, createBranchClient } from "./gh.js";
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
	"usage: pr-finish-cli.ts <pr-number> [--dry-run] [--expected-scope <glob>]...",
	"                         [--keep-branch] [--repo-root <path>]",
	"",
	"Finishes a PR: preflight (clean tree + pr status) → local-CI gate →",
	"merge gates (OPEN + not-BEHIND + CLEAN) → squash-merge → verify_merge →",
	"branch cleanup (delete local+remote head branch, fetch --prune). Local CI",
	"is the gate (remote CI waiting is intentionally NOT ported). Prints the",
	"structured outcome as JSON on stdout. Exit 0 on success (incl. dry-run),",
	"1 on abort, 2 on usage error.",
	"Options:",
	"  --pr <n>               PR number (same as the positional form)",
	"  --dry-run              run read-only gates, emit planned commands only",
	"  --expected-scope <g>   repeatable; verify_merge scope prefix",
	"  --keep-branch          skip post-merge branch deletion + prune",
	"  --repo-root <path>     default: the repo this file lives in",
].join("\n");

/** Repo root inferred from this file's location (`<root>/bun-apps/<pkg>/src/`). */
export function defaultRepoRoot(): string {
	return path.resolve(import.meta.dir, "..", "..", "..");
}

/** Parsed argv. */
export interface ParsedPrFinishArgs {
	pr: number;
	dryRun: boolean;
	expectedScope: string[];
	keepBranch: boolean;
	repoRoot?: string;
}

/** Pure argv → flags (or a usage-error message). Exported for tests. */
export function parsePrFinishArgs(argv: string[]): { ok: true; args: ParsedPrFinishArgs } | { ok: false; message: string } {
	let pr: number | undefined;
	let dryRun = false;
	let expectedScope: string[] = [];
	let keepBranch = false;
	let repoRoot: string | undefined;

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
			expectedScope.push(v);
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
	return { ok: true, args: { pr, dryRun, expectedScope, keepBranch, repoRoot } };
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
	aborted?: { aborted: true; reason: string; message: string };
}

/** Injectable seams (`gh`, `client`, `spawn`, `repoRoot`, `runCi`) for tests. */
export interface PrFinishDeps {
	gh?: GhClient;
	client?: BranchClient;
	spawn?: SpawnFn;
	repoRoot?: string;
	/** Defaults to the real `runLocalCi`; tests stub it (offline). */
	runCi?: (opts: Parameters<typeof runLocalCi>[0]) => Promise<CiOutcome>;
}

/** Wrap a SpawnFn so every invocation is recorded (rendered runnable). */
function recordingSpawn(spawn: SpawnFn): { fn: SpawnFn; commands: string[] } {
	const commands: string[] = [];
	const fn: SpawnFn = async (cmd, args) => {
		commands.push([cmd, ...args].join(" "));
		return spawn(cmd, args);
	};
	return { fn, commands };
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Pure argv → result. `gh` / `client` / `spawn` / `runCi` are injectable so
 * tests never touch a real repo or a real gh; the live entry point below
 * supplies the real set (the same wiring extensions/devops.ts uses).
 */
export async function runPrFinishCli(argv: string[], deps: PrFinishDeps = {}): Promise<PrFinishCliResult> {
	const parsed = parsePrFinishArgs(argv);
	if (!parsed.ok) {
		// --help: usage on stderr with exit 0 (matches sync-cli).
		if (argv.includes("-h") || argv.includes("--help")) {
			return { exitCode: 0, stdout: "", stderr: PR_FINISH_CLI_USAGE };
		}
		return { exitCode: 2, stdout: "", stderr: `${parsed.message}\n${PR_FINISH_CLI_USAGE}` };
	}
	const { pr, dryRun, expectedScope, keepBranch } = parsed.args;
	const repoRoot = parsed.args.repoRoot ?? deps.repoRoot ?? defaultRepoRoot();

	const recorded = recordingSpawn(deps.spawn ?? createLiveSpawn(repoRoot));
	const spawn = recorded.fn;
	const gh = deps.gh ?? createGhClient(spawn);
	const client = deps.client ?? createBranchClient(spawn);
	const runCi = deps.runCi ?? runLocalCi;

	const commands = recorded.commands;
	const warnings: string[] = [];
	const abort = (reason: string, message: string): PrFinishCliResult => {
		const outcome: PrFinishOutcome = {
			pr,
			merged: false,
			verdict: "NOT-MERGED",
			branchSpent: false,
			commands,
			warnings,
			...(dryRun ? { dryRun: true } : {}),
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

	let status;
	try {
		status = await gh.prStatus(pr);
	} catch (err) {
		return abort("pr-status-failed", `gh.prStatus(${pr}) failed: ${errMsg(err)}`);
	}

	// --- 2. Local-CI gate (remote-CI waiting intentionally NOT ported). ------
	let ci: CiOutcome;
	try {
		ci = await runCi({ repoRoot, baseRef: status.baseRefName, headRef: status.headRefName, spawn });
	} catch (err) {
		return abort("local_ci_failed", `local CI threw: ${errMsg(err)}`);
	}
	if (ci.overall !== "pass") {
		return abort("local_ci_failed", `local CI ${ci.overall} for ${status.baseRefName}..${status.headRefName} (${ci.elapsedMs}ms) — fix before merging`);
	}

	// --- 3. Merge gates. ------------------------------------------------------
	if (status.state !== "OPEN") {
		return abort("not-open", `PR #${pr} state is ${status.state}, expected OPEN`);
	}
	if (status.mergeState === "BEHIND") {
		return abort("behind", `PR #${pr} is BEHIND ${status.baseRefName} — run prepare_branch (rebase) first`);
	}
	if (status.mergeState !== "CLEAN") {
		return abort("not-clean", `PR #${pr} mergeState is ${status.mergeState}, expected CLEAN`);
	}

	// --- dry-run stops here: emit the planned commands, mutate nothing. ------
	if (dryRun) {
		const planned = [`gh pr merge ${pr} --squash`];
		if (!keepBranch && status.headRefName) {
			planned.push(`git branch -D ${status.headRefName}`);
			planned.push(`git push origin --delete ${status.headRefName}`);
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
		};
		return { exitCode: 0, stdout: JSON.stringify(outcome, null, 2), stderr: "" };
	}

	// --- 4. Merge (squash; branch deletion is our own cleanup below). --------
	try {
		await gh.mergeNow(pr, "squash", false);
	} catch (err) {
		return abort("merge-failed", `gh pr merge ${pr} --squash failed: ${errMsg(err)}`);
	}

	// --- 5. Verify (read-only; CONTAMINATED warns, never rolls back). -------
	let verify: VerifyMergeOutcome;
	try {
		verify = await runVerifyMerge({ gh, client, spawn, repoRoot, pr, expectedScope });
	} catch (err) {
		verify = {
			pr,
			state: "MERGED",
			merged: true,
			verdict: "CLEAN",
			files: [],
			fileCount: 0,
			insertions: 0,
			deletions: 0,
			outOfScope: [],
			branchSpent: false,
			commands: [],
			warnings: [`runVerifyMerge threw: ${errMsg(err)}`],
		};
	}
	warnings.push(...verify.warnings);
	if (verify.aborted) {
		warnings.push(`verify_merge aborted (${verify.aborted.reason}): ${verify.aborted.message}`);
	}
	if (verify.verdict === "CONTAMINATED") {
		warnings.push(
			`CONTAMINATED merge: ${verify.outOfScope.length} out-of-scope file(s): ${verify.outOfScope.map((f) => f.path).join(", ")} — NOT rolled back`,
		);
	}

	// --- 6. Cleanup: delete the spent head branch, prune (unless kept). ------
	const headRefName = status.headRefName;
	if (!keepBranch) {
		if (verify.branchSpent && headRefName) {
			for (const [label, del] of [
				["deleteLocalBranch", () => client.deleteLocalBranch(headRefName)],
				["deleteRemoteBranch", () => client.deleteRemoteBranch(headRefName)],
			] as const) {
				try {
					await del();
				} catch (err) {
					warnings.push(`${label}(${headRefName}) failed: ${errMsg(err)}`);
				}
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
	};
	return { exitCode: 0, stdout: JSON.stringify(outcome, null, 2), stderr: "" };
}

if (import.meta.main) {
	const res = await runPrFinishCli(Bun.argv.slice(2));
	if (res.stderr) process.stderr.write(`${res.stderr}\n`);
	if (res.stdout) process.stdout.write(`${res.stdout}\n`);
	process.exit(res.exitCode);
}
