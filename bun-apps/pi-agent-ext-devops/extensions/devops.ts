/**
 * DevOps extension — robust, tool-based PR-merge lifecycle that replaces the
 * brittle agent-side bash polling loops (the `gh pr checks | grep -c` footguns
 * that silently mis-counted + wasted turns). All gh output is parsed as
 * STRUCTURED JSON; the full merge recipe lives in tested code (src/).
 *
 * Tools:
 *   - await_pr_merge: poll checks → enable --auto → on BEHIND rebase+force-push
 *     → wait for MERGED. Returns merged/failed/timed-out + check tally. Streams
 *     live per-poll progress to the TUI (elapsed + checks + action) and is
 *     abortable via its AbortSignal.
 *   - pr_status: one-shot PR snapshot (state + mergeState + checks).
 *
 * Install: registered in bun-apps/pi-agent/run-dir/manifest.json (extensions[]).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createGhClient, type SpawnFn } from "../src/gh.js";
import { runMergeRecipe } from "../src/recipe.js";
import { formatProgress } from "../src/progress.js";

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Live Bun.spawn adapter — the only untested seam (thin stdlib passthrough). */
function liveSpawn(cwd: string): SpawnFn {
	return async (cmd, args) => {
		const proc = Bun.spawn([cmd, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		return { stdout, stderr, exitCode: await proc.exited };
	};
}

async function currentBranch(spawn: SpawnFn): Promise<string | undefined> {
	const r = await spawn("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
	return r.exitCode === 0 ? r.stdout.trim() || undefined : undefined;
}

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "await_pr_merge",
		label: "Await a GitHub PR merge (robust — replaces bash polling loops)",
		description:
			"Poll a PR's CI checks, enable auto-merge when they pass, on BEHIND rebase+force-push the feature branch so checks re-run, and wait for MERGED. A robust, tool-based replacement for brittle agent-side `gh pr checks | grep` polling loops. Returns merged/failed/timed-out + a check tally. Wraps the `gh` CLI (structured JSON — no grep footguns). Default strategy rebase, default timeout 600s, auto-deletes the branch on merge, auto force-pushes on BEHIND (powerful: set handleBehind=fail to opt out).",
		promptSnippet: "Merge a PR end-to-end: poll CI, enable --auto, handle BEHIND via rebase+force-push, wait for MERGED. No bash polling loops.",
		parameters: Type.Object({
			prNumber: Type.Integer({ description: "The PR number to merge." }),
			strategy: Type.Optional(
				Type.String({ description: "Merge strategy: 'rebase' (default), 'merge', or 'squash'." }),
			),
			timeoutSec: Type.Optional(Type.Integer({ description: "Max seconds to wait before returning timedOut (default 600)." })),
			pollIntervalSec: Type.Optional(Type.Integer({ description: "Seconds between polls (default 20)." })),
			deleteBranch: Type.Optional(Type.Boolean({ description: "Delete the branch on merge (default true)." })),
			handleBehind: Type.Optional(
				Type.String({ description: "On BEHIND: 'rebase-force-push' (default — rebases onto origin/main + force-pushes) or 'fail' (return without rebasing)." }),
			),
			branch: Type.Optional(Type.String({ description: "Feature branch to rebase+force-push on BEHIND. Defaults to the current checked-out branch." })),
		}),
		async execute(_id, params, signal, onUpdate) {
			const cwd = process.cwd();
			const spawn = liveSpawn(cwd);
			const gh = createGhClient(spawn);
			const strategy = (params.strategy === "merge" || params.strategy === "squash" ? params.strategy : "rebase") as
				| "rebase"
				| "merge"
				| "squash";
			const branch = (params.branch as string | undefined) ?? (await currentBranch(spawn));
			const outcome = await runMergeRecipe({
				prNumber: params.prNumber as number,
				strategy,
				deleteBranch: params.deleteBranch !== false,
				handleBehind: params.handleBehind === "fail" ? "fail" : "rebase-force-push",
				timeoutMs: ((params.timeoutSec as number | undefined) ?? 600) * 1000,
				pollIntervalMs: ((params.pollIntervalSec as number | undefined) ?? 20) * 1000,
				branch: branch ?? "",
				gh,
				sleeper: { sleep: realSleep },
				clock: { now: () => Date.now() },
				signal,
				onProgress: onUpdate
					? (u) => onUpdate({ content: [{ type: "text" as const, text: formatProgress(u) }] })
					: undefined,
			});
			const checks = outcome.checks
				? `${outcome.checks.pass} pass / ${outcome.checks.fail} fail / ${outcome.checks.pending} pending`
				: "unknown";
			const took = ` Took ${Math.round(outcome.elapsedMs / 1000)}s.`;
			const text = outcome.merged
				? `✅ PR #${params.prNumber} MERGED${outcome.mergeSha ? ` (${outcome.mergeSha.slice(0, 7)})` : ""}.${outcome.behind ? " Rebased + force-pushed during the wait to clear BEHIND." : ""}${took}`
				: outcome.aborted
					? `⏹️ PR #${params.prNumber} await aborted after ${Math.round(outcome.elapsedMs / 1000)}s (last state: ${outcome.finalState}; checks: ${checks}).`
					: outcome.timedOut
						? `⏰ PR #${params.prNumber} not merged after timeout (last state: ${outcome.finalState}; checks: ${checks}). Retry, or inspect with pr_status.`
						: `❌ PR #${params.prNumber} not merged: ${outcome.error ?? "unknown"} (checks: ${checks}).${took}`;
			return { details: outcome, content: [{ type: "text" as const, text }] };
		},
	});

	pi.registerTool({
		name: "pr_status",
		label: "Snapshot a GitHub PR's state + checks",
		description:
			"One-shot snapshot of a PR's merge state + CI check tally (pass/fail/pending). Lighter than await_pr_merge when you only need to inspect, not merge. Wraps `gh pr view`/`gh pr checks` as structured JSON.",
		promptSnippet: "One-shot PR state + check tally (pass/fail/pending). Use instead of a bash gh loop when you only need to inspect.",
		parameters: Type.Object({
			prNumber: Type.Integer({ description: "The PR number to inspect." }),
		}),
		async execute(_id, params) {
			const gh = createGhClient(liveSpawn(process.cwd()));
			const s = await gh.prStatus(params.prNumber as number);
			const c = `${s.checks.pass} pass / ${s.checks.fail} fail / ${s.checks.pending} pending`;
			const text = `PR #${params.prNumber}: state=${s.state}, mergeState=${s.mergeState}, checks=[${c}]${s.mergeSha ? `, mergeSha=${s.mergeSha.slice(0, 7)}` : ""}.`;
			return { details: s, content: [{ type: "text" as const, text }] };
		},
	});
}
