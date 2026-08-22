#!/usr/bin/env bun
/**
 * sweep-merged-branches-cli — bash-callable entry point for `runSweep` (the sweep_merged_branches recipe).
 *
 * `bun bun-apps/s2-agent-ext-devops/src/sweep-merged-branches-cli.ts [--execute]`
 *
 * DRY-RUN BY DEFAULT, exactly like the tool. `--execute` deletes the
 * high-confidence set; `--confirm a,b` additionally deletes named branches that
 * landed in the `review` bucket (still re-guarded — the flag cannot bypass
 * evidence). Worktree-checked-out, protected and current branches are never
 * deleted, local or remote.
 *
 * Exit 1 only when a delete was ATTEMPTED and skipped for a guard/failure
 * reason; a dry-run plan is always exit 0. See src/cli-common.ts for the
 * shared contract.
 */
import { runSweep, type SweepClient } from "./branch-recipe.js";
import { selectForgeClientCached } from "./forge/select.js";
import { createBranchClient } from "./gh.js";
import { createLiveSpawn, type SpawnFn } from "./spawn.js";
import { type CliResult, defaultRepoRoot, emit, helpRequested, jsonResult, usageError } from "./cli-common.js";

export const SWEEP_CLI_USAGE = [
	"usage: sweep-merged-branches-cli.ts [--execute] [--confirm <a,b>] [--protect <a,b>]",
	"                    [--no-local] [--no-remote] [--no-prune] [--limit <n>]",
	"                    [--repo-root <path>]",
	"",
	"Classifies every local + remote branch into delete / review / keep and prints",
	"the plan as JSON on stdout. DRY-RUN unless --execute or --confirm is passed.",
	"Only gh-confirmed MERGED PRs are auto-deletable; uncertain cases go to review",
	"and are never touched without --confirm. Worktree-checked-out, protected and",
	"current branches are never deleted (local OR remote).",
	"",
	"Exit 0 success (incl. any dry-run) · 1 a delete was skipped or failed · 2 usage.",
	"Options:",
	"  --execute           delete the high-confidence set (default: plan only)",
	"  --confirm <a,b>     also delete these reviewed branches (re-guarded)",
	"  --protect <a,b>     extra protected names (main/master/default always are)",
	"  --no-local          do not consider local branches",
	"  --no-remote         do not consider remote branches",
	"  --no-prune          skip the `git fetch --prune` that freshens [gone] hints",
	"  --limit <n>         `gh pr list --limit n` (default 200)",
	"  --repo-root <path>  default: the repo this file lives in",
].join("\n");

export interface ParsedSweepArgs {
	execute: boolean;
	confirm?: string[];
	protect?: string[];
	includeLocal?: boolean;
	includeRemote?: boolean;
	prune?: boolean;
	limit?: number;
	repoRoot?: string;
}

/** Split a comma list, dropping empties/whitespace. */
const csv = (v: string): string[] =>
	v
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

/** Pure argv → flags (or a usage-error message). Exported for tests. */
export function parseSweepArgs(argv: string[]): { ok: true; args: ParsedSweepArgs } | { ok: false; message: string } {
	const args: ParsedSweepArgs = { execute: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--execute") {
			args.execute = true;
		} else if (a === "--no-local") {
			args.includeLocal = false;
		} else if (a === "--no-remote") {
			args.includeRemote = false;
		} else if (a === "--no-prune") {
			args.prune = false;
		} else if (a === "--confirm" || a === "--protect") {
			const v = argv[++i];
			if (v === undefined || v === "") return { ok: false, message: `${a} needs a comma-separated value` };
			const names = csv(v);
			if (names.length === 0) return { ok: false, message: `${a} needs at least one branch name` };
			if (a === "--confirm") args.confirm = names;
			else args.protect = names;
		} else if (a === "--limit") {
			const v = argv[++i];
			const n = Number(v);
			if (!Number.isInteger(n) || n <= 0) {
				return { ok: false, message: `--limit must be a positive integer (got ${JSON.stringify(v ?? "missing")})` };
			}
			args.limit = n;
		} else if (a === "--repo-root") {
			const v = argv[++i];
			if (v === undefined) return { ok: false, message: "--repo-root needs a value" };
			args.repoRoot = v;
		} else if (a === "-h" || a === "--help") {
			return { ok: false, message: "" };
		} else if (a.startsWith("-")) {
			return { ok: false, message: `unknown flag: ${a}` };
		} else {
			return { ok: false, message: `unexpected positional argument: ${a}` };
		}
	}
	return { ok: true, args };
}

export async function runSweepCli(
	argv: string[],
	deps: { client?: SweepClient; spawn?: SpawnFn; repoRoot?: string } = {},
): Promise<CliResult> {
	const parsed = parseSweepArgs(argv);
	if (!parsed.ok) {
		if (helpRequested(argv)) return { exitCode: 0, stdout: "", stderr: SWEEP_CLI_USAGE };
		return usageError(parsed.message, SWEEP_CLI_USAGE);
	}
	const a = parsed.args;
	const repoRoot = a.repoRoot ?? deps.repoRoot ?? defaultRepoRoot();
	const spawn = deps.spawn ?? createLiveSpawn(repoRoot);
	// Sweep needs the git surface + the forge PR listing (REST-first selection,
	// same as every other forge consumer; tests inject deps.client directly).
	// The selection's resolved remote name scopes the git surface — under a
	// non-origin remote, defaultBranch/deleteRemoteBranch/remoteBranches MUST
	// follow it or the sweep silently sees nothing.
	let client: SweepClient;
	if (deps.client) {
		client = deps.client;
	} else {
		const sel = await selectForgeClientCached({ spawn, repoRoot });
		client = { ...createBranchClient(spawn, sel.remoteName), prList: sel.client.prList };
	}

	const outcome = await runSweep({
		client,
		execute: a.execute,
		confirm: a.confirm,
		protected: a.protect,
		includeLocal: a.includeLocal,
		includeRemote: a.includeRemote,
		prune: a.prune,
		limit: a.limit,
	});
	// A dry-run has no `executed`, so it is always 0. A run that DID delete
	// reports 1 when anything was skipped — a guard fired or a delete failed, and
	// either way the caller's "sweep is done" assumption is wrong.
	const skipped = outcome.executed?.skipped.length ?? 0;
	return jsonResult(skipped > 0 ? 1 : 0, outcome);
}

if (import.meta.main) emit(await runSweepCli(Bun.argv.slice(2)));
