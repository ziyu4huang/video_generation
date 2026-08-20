#!/usr/bin/env bun
/**
 * prepare-feature-branch-cli — bash-callable entry point for `runPrepare` (the prepare_feature_branch recipe).
 *
 * `bun bun-apps/pi-agent-ext-devops/src/prepare-feature-branch-cli.ts --rebase --dry-run`
 *
 * This is the one wrapper that can rewrite history, so it keeps the recipe's
 * refusals rather than softening them: `--force-push` is opt-in and never
 * implied, a branch checked out in another worktree aborts `worktree-conflict`
 * BEFORE any mutation, and a conflicted rebase is aborted (`git rebase --abort`,
 * recorded) so you are never left mid-rebase. Preview with `--dry-run` first —
 * it records the exact git commands and spawns zero mutations.
 *
 * See src/cli-common.ts for the shared contract.
 */
import { runPrepare, type PrepareClient } from "./prepare-recipe.js";
import { createBranchClient } from "./gh.js";
import { createLiveSpawn, type SpawnFn } from "./spawn.js";
import { type CliResult, defaultRepoRoot, emit, helpRequested, jsonResult, usageError } from "./cli-common.js";

export const PREPARE_CLI_USAGE = [
	"usage: prepare-feature-branch-cli.ts [--branch <name>] [--base <ref>] [--create] [--rebase]",
	"                      [--force-push] [--dry-run] [--repo-root <path>]",
	"",
	"Creates / rebases / force-pushes a branch and prints the structured outcome as",
	"JSON on stdout. This is what clears a BEHIND pull-request: --rebase, then",
	"--force-push once the rebase is clean.",
	"",
	"Aborts BEFORE mutating when the branch is checked out in another worktree,",
	"and aborts a conflicted rebase cleanly. --force-push is never implied.",
	"",
	"Exit 0 success (incl. --dry-run) · 1 aborted (worktree-conflict /",
	"rebase-conflict / force-push-failed) · 2 usage error.",
	"Options:",
	"  --branch <name>     target branch (default: the current branch)",
	"  --base <ref>        rebase/create base (default: origin/<defaultBranch>)",
	"  --create            create the branch off base (`git checkout -b`)",
	"  --rebase            rebase the branch onto base",
	"  --force-push        push with --force-with-lease (opt-in; default false)",
	"  --dry-run           record the git commands, mutate nothing",
	"  --repo-root <path>  default: the repo this file lives in",
].join("\n");

export interface ParsedPrepareArgs {
	branch?: string;
	base?: string;
	create: boolean;
	rebase: boolean;
	forcePush: boolean;
	dryRun: boolean;
	repoRoot?: string;
}

/** Pure argv → flags (or a usage-error message). Exported for tests. */
export function parsePrepareArgs(
	argv: string[],
): { ok: true; args: ParsedPrepareArgs } | { ok: false; message: string } {
	const args: ParsedPrepareArgs = { create: false, rebase: false, forcePush: false, dryRun: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--create") {
			args.create = true;
		} else if (a === "--rebase") {
			args.rebase = true;
		} else if (a === "--force-push") {
			args.forcePush = true;
		} else if (a === "--dry-run") {
			args.dryRun = true;
		} else if (a === "--branch" || a === "--base" || a === "--repo-root") {
			const v = argv[++i];
			if (v === undefined || v === "") return { ok: false, message: `${a} needs a value` };
			if (a === "--branch") args.branch = v;
			else if (a === "--base") args.base = v;
			else args.repoRoot = v;
		} else if (a === "-h" || a === "--help") {
			return { ok: false, message: "" };
		} else if (a.startsWith("-")) {
			return { ok: false, message: `unknown flag: ${a}` };
		} else {
			return { ok: false, message: `unexpected positional argument: ${a}` };
		}
	}
	if (!args.create && !args.rebase && !args.forcePush) {
		// Every field optional would make a bare invocation a silent no-op that
		// still exits 0 — indistinguishable from "prepared successfully".
		return { ok: false, message: "nothing to do: pass at least one of --create / --rebase / --force-push" };
	}
	return { ok: true, args };
}

export async function runPrepareCli(
	argv: string[],
	deps: { client?: PrepareClient; spawn?: SpawnFn; repoRoot?: string } = {},
): Promise<CliResult> {
	const parsed = parsePrepareArgs(argv);
	if (!parsed.ok) {
		if (helpRequested(argv)) return { exitCode: 0, stdout: "", stderr: PREPARE_CLI_USAGE };
		return usageError(parsed.message, PREPARE_CLI_USAGE);
	}
	const a = parsed.args;
	const repoRoot = a.repoRoot ?? deps.repoRoot ?? defaultRepoRoot();
	const spawn = deps.spawn ?? createLiveSpawn(repoRoot);
	const client = deps.client ?? createBranchClient(spawn);

	const outcome = await runPrepare({
		client,
		spawn,
		repoRoot,
		branch: a.branch,
		base: a.base,
		create: a.create,
		rebase: a.rebase,
		forcePush: a.forcePush,
		dryRun: a.dryRun,
	});
	return jsonResult(outcome.aborted ? 1 : 0, outcome);
}

if (import.meta.main) emit(await runPrepareCli(Bun.argv.slice(2)));
