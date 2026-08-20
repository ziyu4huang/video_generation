#!/usr/bin/env bun
/**
 * main-health-cli — bash-callable entry point for `runMainHealth`.
 *
 * `bun bun-apps/s2-agent-ext-devops/src/main-health-cli.ts`
 *
 * Read-only: runs the full matrix + gate suite in the worktree that holds the
 * default branch and reports whether it is green. Never checks out, syncs, or
 * mutates anything, so it is safe to wire into a cron / pre-flight check.
 *
 * Exit 1 means "the default branch is NOT healthy" — including the abort case
 * where no worktree holds it, because "we could not test it" must never read as
 * "it is fine". See src/cli-common.ts for the shared contract.
 */
import { runMainHealth, type MainHealthClient } from "./main-health-recipe.js";
import { createBranchClient } from "./gh.js";
import { createLiveSpawn, type SpawnFn } from "./spawn.js";
import { type CliResult, defaultRepoRoot, emit, helpRequested, jsonResult, toStderr, usageError } from "./cli-common.js";

export const MAIN_HEALTH_CLI_USAGE = [
	"usage: main-health-cli.ts [--repo-root <path>]",
	"",
	"Runs the FULL test matrix + the whole regression-gates suite against the",
	"default branch, in the worktree that actually has it checked out, and prints",
	"the structured outcome as JSON on stdout. Read-only.",
	"",
	"Exists because run_local_ci is change-scoped and remote CI is disabled: a branch",
	"that avoids a broken package merges green forever and nothing reports that",
	"the default branch itself is red.",
	"",
	"Exit 0 healthy · 1 unhealthy OR untestable (no worktree holds the default",
	"branch) · 2 usage error.",
	"Options:",
	"  --repo-root <path>  default: the repo this file lives in",
].join("\n");

export interface ParsedMainHealthArgs {
	repoRoot?: string;
}

/** Pure argv → flags (or a usage-error message). Exported for tests. */
export function parseMainHealthArgs(
	argv: string[],
): { ok: true; args: ParsedMainHealthArgs } | { ok: false; message: string } {
	let repoRoot: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--repo-root") {
			const v = argv[++i];
			if (v === undefined) return { ok: false, message: "--repo-root needs a value" };
			repoRoot = v;
		} else if (a === "-h" || a === "--help") {
			return { ok: false, message: "" };
		} else if (a.startsWith("-")) {
			return { ok: false, message: `unknown flag: ${a}` };
		} else {
			return { ok: false, message: `unexpected positional argument: ${a}` };
		}
	}
	return { ok: true, args: { repoRoot } };
}

export async function runMainHealthCli(
	argv: string[],
	deps: { client?: MainHealthClient; spawn?: SpawnFn; repoRoot?: string } = {},
): Promise<CliResult> {
	const parsed = parseMainHealthArgs(argv);
	if (!parsed.ok) {
		if (helpRequested(argv)) return { exitCode: 0, stdout: "", stderr: MAIN_HEALTH_CLI_USAGE };
		return usageError(parsed.message, MAIN_HEALTH_CLI_USAGE);
	}
	const repoRoot = parsed.args.repoRoot ?? deps.repoRoot ?? defaultRepoRoot();
	const spawn = deps.spawn ?? createLiveSpawn(repoRoot);
	const client = deps.client ?? createBranchClient(spawn);

	// The schema-cost check is an IMPORT, not a spawn, so its banner would land
	// on OUR stdout and corrupt the JSON payload. Send it to stderr.
	const outcome = await runMainHealth({ client, spawn, log: toStderr });
	// `healthy` is already false on an abort, so this one check covers both.
	return jsonResult(outcome.healthy ? 0 : 1, outcome);
}

if (import.meta.main) emit(await runMainHealthCli(Bun.argv.slice(2)));
