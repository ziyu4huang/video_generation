#!/usr/bin/env bun
/**
 * changed-packages-cli — the bash-callable entry point for `computeChangedPackages`.
 *
 * WHY THIS EXISTS (and why it is NOT an `extensions/cli-subcommand.ts`)
 *   The `changed_packages` job in .github/workflows/ci.yml.disabled used to shell
 *   out to `scripts/ci-changed-packages.sh`. That script was ported to
 *   src/changed-packages.ts and DELETED, but devops exposed the port as a library
 *   only — leaving the job pointing at a path that no longer exists.
 *
 *   CLAUDE.md's `extensions/cli-subcommand.ts` convention covers AGENT-driven
 *   sub-commands surfaced through `pi-agent cli <x>`: they load the pi-agent host,
 *   the extension registry, and the installed workspace. The `changed_packages`
 *   job is the opposite situation — it is the FIRST job in the run, it deliberately
 *   does not run `./.github/actions/setup-env` (no `bun install`, no workspace
 *   link, no built dist/), and it must finish in seconds so the 28-row `tests`
 *   matrix can start. So this is a plain script entry instead: it imports nothing
 *   but two node builtins (transitively, via changed-packages.ts) plus this
 *   package's own spawn seam, and therefore runs off a bare checkout with only
 *   `bun` on PATH.
 *
 * CONTRACT (must match the `changed_packages` job byte-for-byte)
 *   - `--all`                → every discovered package `true` (push-to-main).
 *   - `<baseRef> <headRef>`  → the affected subset for that diff range.
 *   - stdout: ONE line of compact JSON, `{"<pkg>":true|false,…}` sorted by key —
 *     the job does `echo "packages=$json" >> "$GITHUB_OUTPUT"`, and a GitHub
 *     Actions output value must be single-line, so nothing else may be printed on
 *     stdout (diagnostics go to stderr).
 *   - the `tests` job consumes it as
 *     `fromJSON(needs.changed_packages.outputs.packages)[matrix.package] == true`,
 *     so EVERY matrix package must be a key (an absent key reads as `null`, not
 *     `true` → that package's steps would silently no-op).
 *   - exit 0 on success; exit 2 on a usage error.
 *
 * This is a THIN wrapper: all logic (fail-open semantics, reverse-BFS over the
 * live `@repo/*` graph) stays in computeChangedPackages. Nothing is reimplemented
 * here — the wrapper only parses argv, picks a repo root, and serializes.
 */
import path from "node:path";
import { computeChangedPackages } from "./changed-packages.js";
import { createLiveSpawn, type SpawnFn } from "./spawn.js";

export interface ChangedPackagesCliResult {
	exitCode: number;
	/** Exactly what belongs on stdout (empty on a usage error). */
	stdout: string;
	/** Diagnostics / usage errors — never mixed into stdout. */
	stderr: string;
}

export const CHANGED_PACKAGES_CLI_USAGE = [
	"usage: changed-packages-cli.ts --all",
	"       changed-packages-cli.ts <baseRef> <headRef>",
	"",
	"Prints one line of compact JSON: {\"<bun-apps package>\": true|false, …}.",
	"Options: --repo-root <path>  (default: the repo this file lives in)",
].join("\n");

/** Repo root inferred from this file's location (`<root>/bun-apps/<pkg>/src/`). */
export function defaultRepoRoot(): string {
	return path.resolve(import.meta.dir, "..", "..", "..");
}

/**
 * Pure argv → result. `spawn` is injectable so tests never touch a real git repo;
 * the live entry point below supplies `createLiveSpawn`.
 */
export async function runChangedPackagesCli(
	argv: string[],
	deps: { spawn?: SpawnFn; repoRoot?: string } = {},
): Promise<ChangedPackagesCliResult> {
	const args: string[] = [];
	let repoRoot = deps.repoRoot ?? defaultRepoRoot();
	let all = false;

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--all") {
			all = true;
		} else if (a === "--repo-root") {
			const v = argv[++i];
			if (v === undefined) {
				return { exitCode: 2, stdout: "", stderr: `--repo-root needs a value\n${CHANGED_PACKAGES_CLI_USAGE}` };
			}
			repoRoot = v;
		} else if (a === "-h" || a === "--help") {
			return { exitCode: 0, stdout: "", stderr: CHANGED_PACKAGES_CLI_USAGE };
		} else if (a.startsWith("-")) {
			return { exitCode: 2, stdout: "", stderr: `unknown flag: ${a}\n${CHANGED_PACKAGES_CLI_USAGE}` };
		} else {
			args.push(a);
		}
	}

	if (!all && args.length !== 2) {
		return {
			exitCode: 2,
			stdout: "",
			stderr: `expected --all, or exactly 2 refs (got ${args.length})\n${CHANGED_PACKAGES_CLI_USAGE}`,
		};
	}

	const spawn = deps.spawn ?? createLiveSpawn(repoRoot);
	const map = all
		? await computeChangedPackages({ repoRoot, all: true, spawn })
		: await computeChangedPackages({ repoRoot, baseRef: args[0], headRef: args[1], spawn });

	// Compact single-line JSON — a GITHUB_OUTPUT value cannot span lines.
	return { exitCode: 0, stdout: JSON.stringify(map), stderr: "" };
}

if (import.meta.main) {
	const res = await runChangedPackagesCli(Bun.argv.slice(2));
	if (res.stderr) process.stderr.write(`${res.stderr}\n`);
	if (res.stdout) process.stdout.write(`${res.stdout}\n`);
	process.exit(res.exitCode);
}
