#!/usr/bin/env bun
/**
 * reviewer-harvest — runnable entry for the harvest SOP fallback
 * (src/reviewer-harvest.ts is the library).
 *
 * Run this right after dispatching a NAMED reviewer subagent (Agent tool
 * with `name:`); it locates the newest matching transcript under the
 * harness root (claude-glm, PRIMARY) — or, when that finds nothing, the
 * newest matching run record in the pi-harness archive (FALLBACK) — waits
 * for the verdict, prints it as JSON, and writes a durable receipt under
 * <repoRoot>/output/reviewer-harvest/.
 *
 * usage: reviewer-harvest.ts --name <reviewer-name> [options]
 *
 * Options:
 *   --name <n>          REQUIRED — the dispatched subagent name
 *   --harness-root <p>  claude-glm harness root (default ~/.claude-glm)
 *   --pi-runs-root <p>  pi run archive root (default ~/.pi/subagents/runs)
 *   --timeout <sec>     total wait budget; 0 = single check (default 0)
 *   --poll <sec>        delay between checks (default 5)
 *   --repo-root <p>     receipt root (default: the repo this file lives in)
 *
 * stdout: the HarvestResult JSON, nothing else.
 * exit 0 completed · 1 still-running/absent/errored · 2 usage error.
 */
import { harvest, createLiveIo, type HarvestIo } from "../src/reviewer-harvest.js";
import { defaultRepoRoot } from "../src/cli-common.js";
import os from "node:os";
import { join } from "node:path";

export const REVIEWER_HARVEST_USAGE = [
	"usage: reviewer-harvest.ts --name <reviewer-name> [options]",
	"",
	"Poll the newest subagent transcript for <name>, extract the verdict,",
	"write a receipt under <repo-root>/output/reviewer-harvest/.",
	"",
	"Options:",
	"  --name <n>          REQUIRED — the dispatched subagent name",
	"  --harness-root <p>  claude-glm harness root (default ~/.claude-glm)",
	"  --pi-runs-root <p>  pi run archive root (default ~/.pi/subagents/runs)",
	"  --timeout <sec>     total wait budget in seconds; 0 = single check (default 0)",
	"  --poll <sec>        delay between checks in seconds (default 5)",
	"  --repo-root <p>     receipt root (default: the repo this file lives in)",
	"  -h, --help          show this usage",
].join("\n");

export interface ReviewerHarvestCliResult {
	exitCode: number;
	/** Exactly what belongs on stdout (empty on a usage error / --help). */
	stdout: string;
	/** Usage / diagnostics — never mixed into stdout. */
	stderr: string;
}

/** Parse `--flag value` numerics once; caller validates the value itself. */
function numArg(argv: string[], i: number, flag: string): { value?: number; error?: string } {
	const raw = argv[i + 1];
	if (raw === undefined) return { error: `${flag} needs a value` };
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) return { error: `${flag} needs a non-negative number (got ${raw})` };
	return { value };
}

/** Expand a leading `~` the way a shell would (both path flags accept it). */
function expandTilde(v: string): string {
	return v.startsWith("~") ? join(os.homedir(), v.slice(1)) : v;
}

export async function runReviewerHarvestCli(
	argv: string[],
	deps: { repoRoot?: string; io?: HarvestIo } = {},
): Promise<ReviewerHarvestCliResult> {
	let name: string | undefined;
	let harnessRoot: string | undefined;
	let piRunsRoot: string | undefined;
	let timeoutSec: number | undefined;
	let pollSec: number | undefined;
	let repoRoot = deps.repoRoot ?? defaultRepoRoot();

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--name") {
			const v = argv[++i];
			if (v === undefined || v === "") {
				return { exitCode: 2, stdout: "", stderr: `--name needs a value\n${REVIEWER_HARVEST_USAGE}` };
			}
			if (v.startsWith("-")) {
				return {
					exitCode: 2,
					stdout: "",
					stderr: `--name must not start with '-' (got ${v})\n${REVIEWER_HARVEST_USAGE}`,
				};
			}
			name = v;
		} else if (a === "--harness-root") {
			const v = argv[++i];
			if (v === undefined) {
				return { exitCode: 2, stdout: "", stderr: `--harness-root needs a value\n${REVIEWER_HARVEST_USAGE}` };
			}
			harnessRoot = expandTilde(v);
		} else if (a === "--pi-runs-root") {
			const v = argv[++i];
			if (v === undefined) {
				return { exitCode: 2, stdout: "", stderr: `--pi-runs-root needs a value\n${REVIEWER_HARVEST_USAGE}` };
			}
			piRunsRoot = expandTilde(v);
		} else if (a === "--timeout") {
			const r = numArg(argv, i, "--timeout");
			if (r.error) return { exitCode: 2, stdout: "", stderr: `${r.error}\n${REVIEWER_HARVEST_USAGE}` };
			timeoutSec = r.value;
			i++;
		} else if (a === "--poll") {
			const r = numArg(argv, i, "--poll");
			if (r.error) return { exitCode: 2, stdout: "", stderr: `${r.error}\n${REVIEWER_HARVEST_USAGE}` };
			pollSec = r.value;
			i++;
		} else if (a === "--repo-root") {
			const v = argv[++i];
			if (v === undefined) {
				return { exitCode: 2, stdout: "", stderr: `--repo-root needs a value\n${REVIEWER_HARVEST_USAGE}` };
			}
			repoRoot = expandTilde(v);
		} else if (a === "-h" || a === "--help") {
			return { exitCode: 0, stdout: "", stderr: REVIEWER_HARVEST_USAGE };
		} else if (a.startsWith("-")) {
			return { exitCode: 2, stdout: "", stderr: `unknown flag: ${a}\n${REVIEWER_HARVEST_USAGE}` };
		} else {
			return { exitCode: 2, stdout: "", stderr: `unexpected argument: ${a}\n${REVIEWER_HARVEST_USAGE}` };
		}
	}

	if (name === undefined) {
		return { exitCode: 2, stdout: "", stderr: `--name is required\n${REVIEWER_HARVEST_USAGE}` };
	}

	// Throw-free by construction: harvest() never throws; a catastrophic
	// fs failure (e.g. unreadable harness root) degrades to status absent.
	const result = await harvest({
		name,
		harnessRoot,
		piRunsRoot,
		timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : 0,
		pollMs: pollSec !== undefined ? pollSec * 1000 : 5000,
		repoRoot,
		io: deps.io ?? createLiveIo(),
	});
	const exitCode = result.status === "completed" ? 0 : 1;
	return { exitCode, stdout: JSON.stringify(result, null, 2), stderr: "" };
}

if (import.meta.main) {
	const res = await runReviewerHarvestCli(Bun.argv.slice(2));
	if (res.stderr) process.stderr.write(`${res.stderr}\n`);
	if (res.stdout) process.stdout.write(`${res.stdout}\n`);
	process.exit(res.exitCode);
}
