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
import { createGhClient, createBranchClient, type SpawnFn } from "../src/gh.js";
import { runMergeRecipe } from "../src/recipe.js";
import { runSweep, type SweepOutcome } from "../src/branch-recipe.js";
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

/** Render a sweep outcome as a compact, human-readable plan/summary. */
function formatSweep(o: SweepOutcome): string {
	const names = (arr: Array<{ name: string }>) => arr.map((x) => x.name).join(", ") || "—";
	const L: string[] = [];
	L.push(`${o.executed ? "Executed" : "Dry-run plan (pass execute:true to delete)"}.`);
	L.push(`  delete local  (${o.deleteLocal.length}, high): ${names(o.deleteLocal)}`);
	L.push(`  delete remote (${o.deleteRemote.length}, high): ${names(o.deleteRemote)}`);
	L.push(`  review (${o.review.length}, human decides): ${o.review.map((p) => `${p.name} [${p.confidence}: ${p.reason}]`).join(", ") || "—"}`);
	L.push(`  keep   (${o.keep.length}): ${o.keep.map((k) => `${k.name} [${k.reason}]`).join(", ") || "—"}`);
	if (o.executed) {
		const sk = o.executed.skipped.length
			? ` | Skipped: ${o.executed.skipped.map((s) => `${s.name} [${s.reason}]`).join(", ")}`
			: "";
		L.push(`Deleted local: ${o.executed.deletedLocal.join(", ") || "none"} | Deleted remote: ${o.executed.deletedRemote.join(", ") || "none"}${sk}`);
	}
	return L.join("\n");
}

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "await_pr_merge",
		label: "Await a GitHub PR merge (robust — replaces bash polling loops)",
		description:
			"Poll a PR's CI checks, enable auto-merge when they pass, on BEHIND rebase+force-push the feature branch so checks re-run, and wait for MERGED. A robust, tool-based replacement for brittle agent-side `gh pr checks | grep` polling loops. Returns merged/failed/timed-out + a check tally. Wraps the `gh` CLI (structured JSON — no grep footguns). Default strategy rebase, default timeout 600s, auto-deletes the branch on merge, auto force-pushes on BEHIND (powerful: set handleBehind=fail to opt out).",
		gating: { keywords: ["pr", "pull-request", "merge", "merged", "await", "wait", "poll", "devops"] },
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

	pi.registerTool({
		name: "sweep_branches",
		label: "Sweep merged local + remote branches (conservative, dry-run by default)",
		description:
			"Classify every local + remote branch and report which are safe to delete. CONSERVATIVE: a branch is deleted only when gh shows a MERGED PR for it (high confidence); uncertain cases ([gone] without gh proof, or a head ref reused by an open PR) go to a `review` bucket the human decides — never auto-deleted. Worktree-checked-out, protected (main/master/default) and the current branch are NEVER deleted (absolute). Dry-run by default: returns the plan only; pass execute:true to delete the high-confidence set, or confirm:[...] to delete specific reviewed branches. Uses structured git/gh JSON — never `git branch --merged` (wrong for squash merges).",
		gating: { keywords: ["sweep", "branch", "branches", "cleanup", "prune", "delete-branch", "devops"] },
		promptSnippet:
			"Sweep merged local+remote branches. Conservative: delete only on gh-confirmed merge; uncertain → review (human). Dry-run by default; worktree/protected/current never deleted.",
		parameters: Type.Object({
			execute: Type.Optional(Type.Boolean({ description: "Delete the high-confidence set. Default false (dry-run: plan only)." })),
			confirm: Type.Optional(
				Type.Array(Type.String(), { description: "Branches the human reviewed + approved (must have appeared in `review`). Re-guarded; cannot bypass evidence." }),
			),
			includeLocal: Type.Optional(Type.Boolean({ description: "Consider local branches (default true)." })),
			includeRemote: Type.Optional(Type.Boolean({ description: "Consider remote branches (default true)." })),
			protected: Type.Optional(
				Type.Array(Type.String(), { description: "Extra protected names. main/master + the repo default branch are always protected." }),
			),
			prune: Type.Optional(Type.Boolean({ description: "Run `git fetch --prune` first so [gone] hints are fresh (default true)." })),
			limit: Type.Optional(Type.Integer({ description: "`gh pr list --limit N` (default 200)." })),
		}),
		async execute(_id, params) {
			const spawn = liveSpawn(process.cwd());
			const client = createBranchClient(spawn);
			const outcome = await runSweep({
				client,
				execute: params.execute === true,
				confirm: params.confirm as string[] | undefined,
				includeLocal: params.includeLocal as boolean | undefined,
				includeRemote: params.includeRemote as boolean | undefined,
				protected: params.protected as string[] | undefined,
				prune: params.prune as boolean | undefined,
				limit: params.limit as number | undefined,
			});
			return { details: outcome, content: [{ type: "text" as const, text: formatSweep(outcome) }] };
		},
	});
}
