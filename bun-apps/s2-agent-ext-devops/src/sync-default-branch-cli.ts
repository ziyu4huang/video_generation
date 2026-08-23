#!/usr/bin/env bun
/**
 * sync-default-branch-cli — the bash-callable entry point for `runSync` (the sync_default_branch recipe).
 *
 * WHY THIS EXISTS (plain-`pi` discoverability gap):
 *   The devops tools (sync_default_branch et al.) load only via the s2-agent wrapper's
 *   run-dir argv splice. An agent session launched as plain `pi` gets no repo
 *   extensions — and the old bash fallback `scripts/sync-repo.sh` was deleted
 *   after the TS port, leaving nothing but hand-rolled raw git. This is the
 *   purpose-built replacement: the SAME runSync orchestration (same options,
 *   same safety gates — dirty-tree abort, ff-only default, preserve stash)
 *   behind a thin argv wrapper, callable as
 *     bun bun-apps/s2-agent-ext-devops/src/sync-default-branch-cli.ts [--dry-run]
 *
 *   It is a THIN wrapper (mirrors src/changed-packages-cli.ts, the existing bin
 *   pattern): all logic stays in runSync; the real git surface is the same one
 *   extensions/devops.ts wires — createLiveSpawn + createBranchClient. Nothing
 *   is reimplemented here — the wrapper only parses argv and serializes.
 *
 * CONTRACT
 *   - `--mode full|rebase|pull`  sync mode (default: full)
 *   - `--dry-run`                plan only: emit the exact git commands, zero
 *                                mutating spawns (read-only queries still run)
 *   - `--branch <name|auto>`     rebase/pull only — detached-HEAD recovery:
 *                                create (or attach) this branch at the current
 *                                HEAD instead of aborting detached_head.
 *                                `auto` derives the name from the worktree
 *                                folder suffix (video_generation__x → x).
 *   - `--force`                  full-mode only: reset --hard (discards divergent
 *                                commits on the default branch — opt-in)
 *   - `--preserve <path>`        repeatable; overrides the default preserve list
 *   - `--preserve-strict`        shorthand for `preserve: []` (disable preserve)
 *   - `--repo-root <path>`       default: the repo this file lives in
 *   - `--help` / `-h`            usage (exit 0)
 *   - stdout: the full SyncOutcome as JSON (nothing else on stdout)
 *   - exit 0 on success (incl. dry-run); exit 1 when the run aborted
 *     (dirty_tree / divergent / …); exit 2 on a usage error.
 */
import { runSync, type SyncMode, DEFAULT_PRESERVE_PATHS, DEFAULT_SYNC_COMMAND_TIMEOUT_MS } from "./sync-recipe.js";
// Re-exported for existing imports (tests, docs); the canonical home is
// sync-recipe.ts so extensions can import it WITHOUT pulling this CLI module
// (whose import.meta.main top-level await breaks the deploy bundle's CJS
// transform — Gate 1b).
export { DEFAULT_SYNC_COMMAND_TIMEOUT_MS };
import { createBranchClient } from "./gh.js";
import type { BranchClient } from "./branch-recipe.js";
import { createLiveSpawn, withDefaultTimeout, type SpawnFn } from "./spawn.js";
import { resolveRemoteName } from "./remote.js";
import { type CliResult, defaultRepoRoot, emit } from "./cli-common.js";

// This CLI predates src/cli-common.ts and used to carry its own copies of
// defaultRepoRoot / the CliResult shape / the import.meta.main emit tail.
// All three now come from cli-common (the shared contract home); re-exported
// here so existing imports (tests, docs) stay stable.
export { defaultRepoRoot };
export type SyncCliResult = CliResult;

export const SYNC_CLI_USAGE = [
	"usage: sync-default-branch-cli.ts [--mode full|rebase|pull] [--dry-run] [--force]",
	"                    [--branch <name|auto>] [--preserve <path>]... [--preserve-strict]",
	"                    [--timeout-ms <ms>] [--repo-root <path>]",
	"",
	"Runs the sync_default_branch recipe (fetch → advance default branch / rebase / pull,",
	"worktree-aware, submodule sync in full mode) and prints the structured",
	"outcome as JSON on stdout. Exit 0 on success, 1 on abort (dirty_tree /",
	"divergent / ...), 2 on usage error.",
	"Options:",
	"  --mode <m>          full (default) | rebase | pull",
	"  --dry-run           emit the planned git commands, mutate nothing",
	"  --branch <name>     rebase/pull + detached HEAD only: create/attach this",
	"                      branch at the current HEAD instead of aborting",
	"                      ('auto' derives it from the worktree folder suffix)",
	"  --force             full-mode only: reset --hard (discards divergent commits)",
	"  --preserve <path>   repeatable; preserve-listed dirty path (default:",
	"                      " + DEFAULT_PRESERVE_PATHS.join(", ") + ")",
	"  --preserve-strict   disable preserve entirely (preserve: [])",
	"  --timeout-ms <ms>   per-command wall-clock cap on every git/gh spawn",
	"                      (default 180000 = 3 min; a stalled network op is",
	"                      killed + reported as exit 124 instead of hanging)",
	"  --repo-root <path>  default: the repo this file lives in",
].join("\n");

/**
 * Parsed argv. `preserve` follows the SyncOptions convention: undefined ⇒
 * default seed, `[]` ⇒ disabled (--preserve-strict).
 */
export interface ParsedSyncArgs {
	mode: SyncMode;
	dryRun: boolean;
	force: boolean;
	branch?: string;
	preserve: string[] | undefined;
	repoRoot?: string;
	/** Per-command wall-clock cap for every git/gh spawn (see withDefaultTimeout). */
	timeoutMs: number;
}

/** Pure argv → flags (or a usage-error message). Exported for tests. */
export function parseSyncArgs(argv: string[]): { ok: true; args: ParsedSyncArgs } | { ok: false; message: string } {
	let mode: SyncMode = "full";
	let dryRun = false;
	let force = false;
	let branch: string | undefined;
	let preserve: string[] | undefined = undefined;
	let strict = false;
	let repoRoot: string | undefined;
	let timeoutMs = DEFAULT_SYNC_COMMAND_TIMEOUT_MS;

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--dry-run") {
			dryRun = true;
		} else if (a === "--force") {
			force = true;
		} else if (a === "--branch") {
			const v = argv[++i];
			if (v === undefined || v === "") {
				return { ok: false, message: "--branch needs a name value (or 'auto')" };
			}
			branch = v;
		} else if (a === "--timeout-ms") {
			const v = argv[++i];
			const n = Number(v);
			if (v === undefined || !Number.isInteger(n) || n <= 0) {
				return { ok: false, message: `--timeout-ms needs a positive integer (got ${JSON.stringify(v ?? "missing")})` };
			}
			timeoutMs = n;
		} else if (a === "--preserve-strict") {
			strict = true;
		} else if (a === "--mode") {
			const v = argv[++i];
			if (v !== "full" && v !== "rebase" && v !== "pull") {
				return { ok: false, message: `--mode must be full|rebase|pull (got ${JSON.stringify(v ?? "missing")})` };
			}
			mode = v;
		} else if (a === "--preserve") {
			const v = argv[++i];
			if (v === undefined || v === "") {
				return { ok: false, message: "--preserve needs a path value" };
			}
			(preserve ??= []).push(v);
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
			return { ok: false, message: `unexpected positional argument: ${a}` };
		}
	}

	// --preserve-strict overrides any explicit --preserve (explicit [] semantics).
	if (strict) preserve = [];
	return { ok: true, args: { mode, dryRun, force, branch, preserve, repoRoot, timeoutMs } };
}

/**
 * Pure argv → result. `client` and `spawn` are injectable so tests never touch
 * a real git repo; the live entry point below supplies the real pair (the same
 * wiring extensions/devops.ts uses for the sync_default_branch tool).
 */
export async function runSyncCli(
	argv: string[],
	deps: { client?: BranchClient; spawn?: SpawnFn; repoRoot?: string; remoteName?: string } = {},
): Promise<SyncCliResult> {
	const parsed = parseSyncArgs(argv);
	if (!parsed.ok) {
		// --help: usage on stderr with exit 0 (matches changed-packages-cli).
		if (argv.includes("-h") || argv.includes("--help")) {
			return { exitCode: 0, stdout: "", stderr: SYNC_CLI_USAGE };
		}
		return { exitCode: 2, stdout: "", stderr: `${parsed.message}\n${SYNC_CLI_USAGE}` };
	}
	const { mode, dryRun, force, branch, preserve, timeoutMs } = parsed.args;
	const repoRoot = parsed.args.repoRoot ?? deps.repoRoot ?? defaultRepoRoot();

	// Every live git/gh spawn gets a hard cap: a stalled network op must fail
	// fast (exit 124, reported in the outcome's warnings/abort) instead of
	// hanging the CLI for minutes. Injected test spawns are used verbatim.
	const spawn = deps.spawn ?? withDefaultTimeout(createLiveSpawn(repoRoot), timeoutMs);
	// Remote name resolved ONCE here (DEVOPS_REMOTE > git config devops.remote >
	// origin — src/remote.ts); recipes never resolve it themselves.
	const remoteName = deps.remoteName ?? (await resolveRemoteName(spawn));
	const client = deps.client ?? createBranchClient(spawn, remoteName);

	const outcome = await runSync({ client, spawn, repoRoot, mode, dryRun, force, branch, preserve, remoteName });
	return { exitCode: outcome.aborted ? 1 : 0, stdout: JSON.stringify(outcome, null, 2), stderr: "" };
}

if (import.meta.main) {
	emit(await runSyncCli(Bun.argv.slice(2)));
}
