#!/usr/bin/env bun
/**
 * local-ci-cli — bash-callable entry point for `runLocalCi` (the run_local_ci recipe).
 *
 * `bun bun-apps/s2-agent-ext-devops/src/local-ci-cli.ts [--all] [--strict]`
 *
 * Not a second runner: `scripts/ci-local.sh` executes the workflow's matrix and
 * gate job directly, while this is the change-SCOPED gate `merge_pr_after_local_ci` uses
 * — typecheck + tests for the packages touched vs the base ref, plus the whole
 * regression-gates suite. Both derive their commands from the same workflow, so
 * they cannot disagree about what a package's command or a gate is.
 *
 * See src/cli-common.ts for the shared contract.
 */
import { runLocalCi } from "./ci-recipe.js";
import { createLiveSpawn, type SpawnFn } from "./spawn.js";
import { type CliResult, defaultRepoRoot, emit, helpRequested, jsonResult, toStderr, usageError } from "./cli-common.js";

export const LOCAL_CI_CLI_USAGE = [
	"usage: local-ci-cli.ts [--base <ref>] [--all] [--packages <a,b>] [--strict]",
	"                       [--no-gates] [--repo-root <path>]",
	"",
	"Runs typecheck + lint + tests for the packages changed vs the base ref, plus every",
	"step of the workflow's regression-gates job, and prints the structured",
	"outcome as JSON on stdout. OFFLINE — never fetches; the base ref must already",
	"exist locally.",
	"",
	"Exit 0 pass · 1 fail (incl. a detection error or an unreadable gate job) ·",
	"2 usage error.",
	"Options:",
	"  --base <ref>        base to diff against (default origin/main)",
	"  --all               every bun-apps/* package, not just the changed ones",
	"  --packages <a,b>    explicit package list; skips change detection",
	"  --strict            also run the audits that have NO workflow step",
	"  --no-gates          skip the gate suite entirely (packages only)",
	"  --repo-root <path>  default: the repo this file lives in",
].join("\n");

export interface ParsedLocalCiArgs {
	baseRef?: string;
	all: boolean;
	packages?: string[];
	strict: boolean;
	includeGates: boolean;
	repoRoot?: string;
}

/** Pure argv → flags (or a usage-error message). Exported for tests. */
export function parseLocalCiArgs(
	argv: string[],
): { ok: true; args: ParsedLocalCiArgs } | { ok: false; message: string } {
	const args: ParsedLocalCiArgs = { all: false, strict: false, includeGates: true };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--all") {
			args.all = true;
		} else if (a === "--strict") {
			args.strict = true;
		} else if (a === "--no-gates") {
			args.includeGates = false;
		} else if (a === "--base") {
			const v = argv[++i];
			if (v === undefined || v === "") return { ok: false, message: "--base needs a ref value" };
			args.baseRef = v;
		} else if (a === "--packages") {
			const v = argv[++i];
			if (v === undefined || v === "") return { ok: false, message: "--packages needs a comma-separated value" };
			const names = v
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			if (names.length === 0) return { ok: false, message: "--packages needs at least one package name" };
			args.packages = names;
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
	if (args.all && args.packages) {
		return { ok: false, message: "--all and --packages are mutually exclusive (--packages already names the set)" };
	}
	return { ok: true, args };
}

export async function runLocalCiCli(
	argv: string[],
	deps: { spawn?: SpawnFn; repoRoot?: string } = {},
): Promise<CliResult> {
	const parsed = parseLocalCiArgs(argv);
	if (!parsed.ok) {
		if (helpRequested(argv)) return { exitCode: 0, stdout: "", stderr: LOCAL_CI_CLI_USAGE };
		return usageError(parsed.message, LOCAL_CI_CLI_USAGE);
	}
	const a = parsed.args;
	const repoRoot = a.repoRoot ?? deps.repoRoot ?? defaultRepoRoot();
	const spawn = deps.spawn ?? createLiveSpawn(repoRoot);

	try {
		const outcome = await runLocalCi({
			repoRoot,
			baseRef: a.baseRef,
			all: a.all,
			packages: a.packages,
			strict: a.strict,
			includeGates: a.includeGates,
			spawn,
			// Imported, not spawned: without this the schema-cost banner corrupts
			// the JSON on stdout.
			log: toStderr,
		});
		return jsonResult(outcome.overall === "pass" ? 0 : 1, outcome);
	} catch (e) {
		// runLocalCi throws ONLY when the base ref cannot be resolved locally (it
		// stays offline and never fetches). That is a real blocker, not a usage
		// error, so it exits 1 with the message on stderr rather than 2.
		return { exitCode: 1, stdout: "", stderr: (e as Error).message };
	}
}

if (import.meta.main) emit(await runLocalCiCli(Bun.argv.slice(2)));
