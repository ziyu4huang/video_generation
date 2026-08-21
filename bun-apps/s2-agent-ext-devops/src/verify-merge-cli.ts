#!/usr/bin/env bun
/**
 * verify-merge-cli — bash-callable entry point for `runVerifyMerge`.
 *
 * `bun bun-apps/s2-agent-ext-devops/src/verify-merge-cli.ts 1360 --scope bun-apps/`
 *
 * Read-only. Confirms the PR actually merged, diffs the merge commit's REAL
 * file scope against `--scope` (verdict CLEAN vs CONTAMINATED), and reports
 * whether the branch is now spent. This replaces hand-rolled
 * `git show --stat` parsing, which mis-split binary and summary lines and
 * reported CLEAN on merges that had drifted out of scope.
 *
 * Exit 1 covers four distinct bad outcomes — not merged, CONTAMINATED,
 * UNVERIFIED, or a status lookup that failed. All four mean "do not proceed as
 * if this merge was verified", and the JSON on stdout says which. See
 * src/cli-common.ts.
 *
 * UNVERIFIED is the one added late (issue #1439): the merge's files could not
 * be read, so the scope check never ran. It used to report CLEAN / exit 0 with
 * `fileCount: 0`, which is the same answer as a genuinely clean merge. Right
 * after `gh pr merge` the squash commit is not in the local object store yet,
 * so this was the NORMAL post-merge result, not a rare edge. Pass `--fetch` to
 * pull that one object and actually verify.
 */
import { runVerifyMerge, type VerifyMergeClient } from "./verify-merge-recipe.js";
import { createBranchClient } from "./gh.js";
import { selectForgeClientCached } from "./forge/select.js";
import type { GhClient } from "./recipe.js";
import { createLiveSpawn, type SpawnFn } from "./spawn.js";
import { type CliResult, defaultRepoRoot, emit, helpRequested, jsonResult, usageError } from "./cli-common.js";

export const VERIFY_MERGE_CLI_USAGE = [
	"usage: verify-merge-cli.ts <pr-number> [--scope <a,b>] [--fetch] [--repo-root <path>]",
	"",
	"Confirms a PR merged, checks the merge commit's real file scope against the",
	"expected prefixes, and reports whether the branch is spent. Read-only; prints",
	"the structured outcome as JSON on stdout.",
	"",
	"Exit 0 merged AND CLEAN · 1 not merged, CONTAMINATED, UNVERIFIED, or status",
	"lookup failed · 2 usage error.",
	"Options:",
	"  --scope <a,b>       expected path prefixes; anything outside ALL of them",
	"                      makes the verdict CONTAMINATED",
	"  --fetch             allow one `git fetch origin <mergeSha>` when the merge",
	"                      commit is not local yet (the usual case right after a",
	"                      merge). Without it such a run reports UNVERIFIED.",
	"  --repo-root <path>  default: the repo this file lives in",
].join("\n");

export interface ParsedVerifyMergeArgs {
	pr: number;
	expectedScope?: string[];
	allowFetch?: boolean;
	repoRoot?: string;
}

/** Pure argv → flags (or a usage-error message). Exported for tests. */
export function parseVerifyMergeArgs(
	argv: string[],
): { ok: true; args: ParsedVerifyMergeArgs } | { ok: false; message: string } {
	let pr: number | undefined;
	let expectedScope: string[] | undefined;
	let repoRoot: string | undefined;
	let allowFetch = false;

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--scope") {
			const v = argv[++i];
			if (v === undefined || v === "") return { ok: false, message: "--scope needs a comma-separated value" };
			const parts = v
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			if (parts.length === 0) return { ok: false, message: "--scope needs at least one path prefix" };
			expectedScope = parts;
		} else if (a === "--fetch") {
			allowFetch = true;
		} else if (a === "--repo-root") {
			const v = argv[++i];
			if (v === undefined) return { ok: false, message: "--repo-root needs a value" };
			repoRoot = v;
		} else if (a === "-h" || a === "--help") {
			return { ok: false, message: "" };
		} else if (a.startsWith("-")) {
			return { ok: false, message: `unknown flag: ${a}` };
		} else if (pr === undefined) {
			const n = Number(a);
			if (!Number.isInteger(n) || n <= 0) {
				return { ok: false, message: `pr-number must be a positive integer (got ${JSON.stringify(a)})` };
			}
			pr = n;
		} else {
			return { ok: false, message: `unexpected positional argument: ${a}` };
		}
	}
	if (pr === undefined) return { ok: false, message: "missing required <pr-number>" };
	return { ok: true, args: { pr, expectedScope, allowFetch, repoRoot } };
}

export async function runVerifyMergeCli(
	argv: string[],
	deps: { gh?: GhClient; client?: VerifyMergeClient; spawn?: SpawnFn; repoRoot?: string } = {},
): Promise<CliResult> {
	const parsed = parseVerifyMergeArgs(argv);
	if (!parsed.ok) {
		if (helpRequested(argv)) return { exitCode: 0, stdout: "", stderr: VERIFY_MERGE_CLI_USAGE };
		return usageError(parsed.message, VERIFY_MERGE_CLI_USAGE);
	}
	const a = parsed.args;
	const repoRoot = a.repoRoot ?? deps.repoRoot ?? defaultRepoRoot();
	const spawn = deps.spawn ?? createLiveSpawn(repoRoot);
	const gh = deps.gh ?? (await selectForgeClientCached({ spawn, repoRoot })).client;
	const client = deps.client ?? createBranchClient(spawn);

	const outcome = await runVerifyMerge({
		gh,
		client,
		spawn,
		repoRoot,
		pr: a.pr,
		expectedScope: a.expectedScope,
		allowFetch: a.allowFetch,
	});
	// Gate on CLEAN positively rather than excluding known-bad verdicts: the old
	// `!== "CONTAMINATED"` form meant every verdict added later defaulted to
	// PASS, which is how UNVERIFIED would have shipped as an exit-0 too.
	const ok = !outcome.aborted && outcome.merged && outcome.verdict === "CLEAN";
	return jsonResult(ok ? 0 : 1, outcome);
}

if (import.meta.main) emit(await runVerifyMergeCli(Bun.argv.slice(2)));
