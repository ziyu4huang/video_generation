/**
 * Shared plumbing for the devops CLI fallbacks.
 *
 * WHY THE CLIs EXIST
 *   The devops tools load only via the s2-agent wrapper's run-dir argv splice.
 *   A session launched as plain `pi` — or any non-pi agent session — gets none
 *   of them. The SKILL forbids hand-rolling raw git for the phases those tools
 *   own (that is what produced scope-verification false-positives and
 *   worktree-blocked checkouts), but until now only `sync` had a fallback, so
 *   every other phase had no legal path at all. These wrappers close that.
 *
 * WHAT A WRAPPER IS ALLOWED TO DO
 *   Parse argv and serialize. Nothing else. All logic stays in the recipe, and
 *   the git/gh surface is the same `createLiveSpawn` + `createBranchClient` pair
 *   extensions/devops.ts wires — so the CLI and the tool cannot diverge in
 *   behavior, only in presentation.
 *
 * SHARED CONTRACT
 *   - stdout: the structured outcome as JSON, and nothing else
 *   - stderr: usage + diagnostics, never mixed into stdout
 *   - exit 0 success · 1 the run reports failure/abort · 2 usage error
 *   - `--help`/`-h` prints usage on stderr and exits 0
 *   - `--repo-root <path>` everywhere; defaults to the repo this file lives in
 */
import path from "node:path";

export interface CliResult {
	exitCode: number;
	/** Exactly what belongs on stdout (empty on a usage error / --help). */
	stdout: string;
	/** Diagnostics / usage — never mixed into stdout. */
	stderr: string;
}

/** Repo root inferred from this file's location (`<root>/bun-apps/<pkg>/src/`). */
export function defaultRepoRoot(): string {
	return path.resolve(import.meta.dir, "..", "..", "..");
}

/** A usage error: exit 2, message + usage on stderr. */
export function usageError(message: string, usage: string): CliResult {
	return { exitCode: 2, stdout: "", stderr: `${message}\n${usage}` };
}

/** `--help`/`-h`: usage on stderr, exit 0 (matches changed-packages-cli). */
export function helpRequested(argv: string[]): boolean {
	return argv.includes("-h") || argv.includes("--help");
}

/**
 * The log sink every CLI must hand to any recipe that PRINTS.
 *
 * `runSchemaCostCheck` is imported, not spawned, so its comparison banner lands
 * on the caller's own stdout — which for a CLI is the JSON payload. That made
 * `main-health-cli` emit unparseable output, and no fake-driven test caught it
 * because a fake never reaches that code path. Diagnostics belong on stderr.
 */
export function toStderr(line: string): void {
	process.stderr.write(`${line}\n`);
}

/** Serialize an outcome as the JSON stdout payload. */
export function jsonResult(exitCode: number, outcome: unknown): CliResult {
	return { exitCode, stdout: JSON.stringify(outcome, null, 2), stderr: "" };
}

/**
 * The `import.meta.main` tail every CLI shares: write, then exit with the code.
 * Kept here so a wrapper cannot accidentally print diagnostics onto stdout and
 * break a caller that pipes the JSON.
 */
export function emit(res: CliResult): never {
	if (res.stderr) process.stderr.write(`${res.stderr}\n`);
	if (res.stdout) process.stdout.write(`${res.stdout}\n`);
	process.exit(res.exitCode);
}
