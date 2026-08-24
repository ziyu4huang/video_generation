/**
 * DevOps extension — tool-based PR-merge lifecycle. All gh output is parsed
 * as STRUCTURED JSON (no `gh pr checks | grep -c` footguns); the full merge
 * recipe lives in tested code (src/).
 *
 * Tools:
 *   - merge_pr_after_local_ci: a LOCAL-CI-GATED merge. Runs run_local_ci (offline
 *     typecheck+tests+gates over the PR's changed packages vs its base), then
 *     squash-merges when green + CLEAN. Blocks on red CI / detection error /
 *     BEHIND / non-CLEAN. No remote CI (disabled in this repo), no polling.
 *   - show_pr_status: one-shot PR snapshot (state + mergeState + check tally).
 *   - run_local_ci: OFFLINE local CI — typecheck + tests scoped to changed packages
 *     vs origin/main, plus repo gates. Structured pass/fail; self-verify before
 *     `gh ship` (merge_pr_after_local_ci gates on this).
 *
 * Install: registered in bun-apps/s2-agent/run-dir/manifest.json (extensions[]).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { GATE_DEFS } from "@repo/s2-agent-core-interface";
import { createBranchClient } from "../src/gh.js";
import { selectForgeClientCached } from "../src/forge/select.js";
import { resolveRemoteName } from "../src/remote.js";
import { createLiveSpawn, withDefaultTimeout } from "../src/spawn.js";
import { SYNC_DEFAULT_TIMEOUT_MS } from "../src/sync-recipe.js";
import { runMergeRecipe } from "../src/recipe.js";
import { runSweep, type SweepOutcome } from "../src/branch-recipe.js";
import { runLocalCi, type CiOutcome } from "../src/ci-recipe.js";
import { runSync, type SyncMode, type SyncOutcome, type SyncSubmodule } from "../src/sync-recipe.js";
import { runRetrospect, type RetrospectOutcome } from "../src/retrospect-recipe.js";
import { runPrepare, type PrepareOutcome } from "../src/prepare-recipe.js";
import { runVerifyMerge, type VerifyMergeOutcome } from "../src/verify-merge-recipe.js";
import { runDeploy } from "../src/deploy-tool.js";
import { runVerify } from "../src/verify-tool.js";
import { runMainHealth, type MainHealthOutcome } from "../src/main-health-recipe.js";

// ─── Gate families (wayfinder ticket 01 — reference form) ───────────────────
// Declared ONCE by id; each devops tool references its family via
// `gating: { gate: "<id>" }` so buildEffectiveGates resolves keywords/requires
// from the registry. deploy_pi_agent_sh + verify_pi_agent_deploy share ONE family (their former
// byte-identical inline gating). The per-tool verbatim duplication is gone —
// edit a family here, its tool(s) follow.
// The FIRST keyword of each family is its legacy pre-rename id (e.g.
// "await_pr_merge") — kept so wayfinder keeps matching historical transcripts
// that reference the old tool names.
GATE_DEFS["merge_pr_after_local_ci"] = {
  id: "merge_pr_after_local_ci",
  keywords: ["await_pr_merge", "pr", "pull-request", "merge", "merged", "ship", "gate", "local ci", "devops"],
  description: "Merge a PR gated on local CI",
};
GATE_DEFS["sweep_merged_branches"] = {
  id: "sweep_merged_branches",
  keywords: ["sweep_branches", "sweep", "branch", "branches", "cleanup", "prune", "delete-branch", "devops"],
  description: "Sweep/cleanup spent local branches",
};
GATE_DEFS["run_local_ci"] = {
  id: "run_local_ci",
  keywords: ["local_ci", "ci", "test", "typecheck", "verify", "gate", "green", "merge", "local ci"],
  description: "Run offline local CI scoped to changed packages",
};
GATE_DEFS["check_main_health"] = {
  id: "check_main_health",
  keywords: ["main_health", "main", "health", "green", "red", "default branch", "broken", "status", "ci", "devops"],
  description: "Check whether the default branch is green",
};
GATE_DEFS["sync_default_branch"] = {
  id: "sync_default_branch",
  keywords: ["sync_repo", "sync", "git sync", "fetch", "rebase", "pull", "default branch", "remote default", "origin/main", "origin/master", "submodule", "reset --hard", "merge --ff-only", "fast-forward", "ff-only", "force", "update main", "bring main", "get latest", "latest changes", "devops"],
  requires: {
    nouns: ["main", "branch", "repo", "repository", "worktree", "origin"],
    verbs: ["up to date", "up-to-date"],
  },
  description: "Sync this repo to the latest default branch",
};
GATE_DEFS["run_devops_retrospect"] = {
  id: "run_devops_retrospect",
  keywords: ["devops_retrospect", "retrospect", "review", "reflect", "post-run", "anomaly"],
  description: "Post-run devops retrospect / anomaly review",
};
GATE_DEFS["prepare_feature_branch"] = {
  id: "prepare_feature_branch",
  keywords: ["prepare_branch", "prepare", "rebase", "force-push", "branch", "behind"],
  description: "Prepare a branch against the default branch",
};
GATE_DEFS["verify_merge_landed"] = {
  id: "verify_merge_landed",
  keywords: ["verify_merge", "verify", "merge", "scope", "contaminated", "spent"],
  description: "Verify a PR merge landed cleanly",
};
GATE_DEFS["deploy_pi_agent_sh"] = {
  id: "deploy_pi_agent_sh",
  keywords: ["pi_deploy", "pi_verify", "build bundle", "bundle s2-agent", "s2-agent bundle", "run-test"],
  requires: {
    nouns: ["bundle", "s2-agent", "pi agent", "extension"],
    verbs: ["build", "deploy", "verify", "bundle", "部署", "建置", "驗證", "打包"],
  },
  description: "Build & deploy the s2-agent bundle",
};

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

/** ✓/✗ for an exit code (0 → ✓, else ✗). */
function mark(exit: number): string {
	return exit === 0 ? "✓" : "✗";
}

/** Render a test result: ✓ / ✗ exit N / – (no test script). */
function fmtTest(t: { exitCode: number; note?: string }): string {
	if (t.exitCode === -1) return "– (no test)";
	return mark(t.exitCode) + (t.exitCode !== 0 ? ` exit ${t.exitCode}` : "");
}

/** Render a typecheck / lint result: ✓ / ✗ / skip / –. */
function fmtTypecheck(tc?: { exitCode: number; skipped?: boolean; note?: string }): string {
	if (!tc) return "–";
	if (tc.skipped) return "skip";
	return mark(tc.exitCode);
}

/** Render a local-CI outcome as a compact, human-readable pass/fail summary. */
function formatCiOutcome(o: CiOutcome): string {
	const L: string[] = [];
	const secs = (o.elapsedMs / 1000).toFixed(1);
	L.push(
		`${o.overall === "pass" ? "✅" : "❌"} Local CI ${o.overall.toUpperCase()} — ${o.packages.length} pkg(s), ${o.gates.length} gate(s), ${secs}s (vs ${o.baseRef}..${o.headRef}).`,
	);
	if (o.packages.length === 0) {
		L.push("  No packages affected.");
	} else {
		for (const p of o.packages) {
			// On a FAILURE, name the exact command that failed — for a matrix-sourced
			// package that is the CI row (e.g. `bun test --isolate`), not the generic
			// `bun run test`, and the difference is usually the whole diagnosis.
			const cmd = p.test.exitCode > 0 && p.test.command ? ` [${p.test.command}]` : "";
			L.push(
				`  ${p.name}: test ${fmtTest(p.test)}${cmd} (typecheck ${fmtTypecheck(p.typecheck)}, lint ${fmtTypecheck(p.lint)})`,
			);
		}
	}
	// A gate-read failure is NOT "0 gates passed" — say so loudly, since the run
	// is blocked for a reason no per-gate line can show.
	if (o.gateError) L.push(`Gates: NOT RUN — could not read the regression-gates job: ${o.gateError}`);
	if (o.gates.length) {
		const pass = o.gates.filter((g) => g.exitCode === 0).length;
		const failed = o.gates.filter((g) => g.exitCode !== 0).map((g) => g.name);
		L.push(`Gates: ${pass} pass / ${o.gates.length - pass} fail.${failed.length ? ` ✗ ${failed.join(", ")}` : ""}`);
	}
	if (o.schemaCost) {
		L.push(`Schema-cost: ${o.schemaCost.exitCode === 0 ? "✓" : `✗ exit ${o.schemaCost.exitCode}`} (${o.schemaCost.note}).`);
	}
	return L.join("\n");
}

/** Render a check_main_health outcome: verdict, what was tested, what is red. */
function formatMainHealth(o: MainHealthOutcome): string {
	if (o.aborted) return `❓ check_main_health: ${o.aborted} — ${o.message}`;
	const secs = (o.elapsedMs / 1000).toFixed(1);
	const L: string[] = [
		`${o.healthy ? "✅" : "❌"} ${o.defaultBranch} is ${o.healthy ? "GREEN" : "RED"} — ` +
			`${o.ci?.packages.length ?? 0} pkg(s), ${o.ci?.gates.length ?? 0} gate(s), ${secs}s.`,
		`  tested: ${o.head?.slice(0, 8) ?? "?"} in ${o.worktree}`,
	];
	if (o.failingPackages.length) L.push(`  ✗ packages: ${o.failingPackages.join(", ")}`);
	// Kept visually distinct from ✗: an uninstalled worktree is not a broken branch.
	if (o.toolchainMissing.length) L.push(`  ? not typechecked (no toolchain): ${o.toolchainMissing.join(", ")}`);
	if (o.failingGates.length) L.push(`  ✗ gates: ${o.failingGates.join(", ")}`);
	if (o.gateError) L.push(`  ✗ gates NOT RUN: ${o.gateError}`);
	for (const w of o.warnings) L.push(`  ⚠ ${w}`);
	return L.join("\n");
}

/** Render a sync_default_branch outcome: status line, advancements (+ the commits they
 *  moved), verification, per-worktree submodule report, caller post-state,
 *  warnings, and the full command list (the primary output under dryRun). */
function formatSync(o: SyncOutcome): string {
	const L: string[] = [];
	const head = o.aborted
		? `⛔ sync_default_branch (${o.mode}) ABORTED [${o.aborted.reason}]: ${o.aborted.message}${o.aborted.hint ? ` — ${o.aborted.hint}` : ""}`
		: o.dryRun
			? `🔍 sync_default_branch (${o.mode}) DRY-RUN — no mutations performed.`
			: `✅ sync_default_branch (${o.mode}) complete.`;
	L.push(`${head} default=${o.defaultBranch || "?"}.`);
	for (const a of o.advanced) {
		L.push(`  advanced ${a.branch} @ ${a.worktree}: ${a.from.slice(0, 7)} → ${a.to.slice(0, 7)} (${a.count} commit(s))`);
		if (a.subjects.length) L.push(`    ${a.subjects.join(" | ")}`);
	}
	if (o.verification) {
		L.push(
			`  verification: ${o.verification.local.slice(0, 7) || "?"} ${o.verification.ok ? "==" : "!="} ${o.verification.remote.slice(0, 7)} (${o.verification.branch} vs its remote-tracking ${o.verification.branch}).`,
		);
	}
	if (o.submodules.length) {
		// Grouped per worktree; the flag carries git's own semantics — no "not-clean":
		// ' ' matches the HEAD-recorded gitlink, '+' drifted from it (typically
		// advanced past it by --remote), '-' not initialized, 'U' merge conflict.
		const byWorktree = new Map<string, SyncSubmodule[]>();
		for (const s of o.submodules) {
			const list = byWorktree.get(s.worktree) ?? [];
			list.push(s);
			byWorktree.set(s.worktree, list);
		}
		for (const [wt, subs] of byWorktree) {
			const off = subs.filter((s) => !s.matchesRecordedGitlink);
			L.push(`  submodules @ ${wt}: ${subs.length} (${off.length} not matching the recorded gitlink).`);
			for (const s of off) {
				const why =
					s.flag === "+" ? "drifted from recorded gitlink" : s.flag === "-" ? "not initialized" : s.flag === "U" ? "merge conflict" : "differs";
				L.push(`    ${why}: ${s.path} @ ${s.sha.slice(0, 7)}`);
			}
		}
	}
	if (o.caller) {
		L.push(
			`  caller: ${o.caller.detached ? "detached HEAD" : o.caller.branch} @ ${o.caller.worktree}${o.caller.behindDefault === null ? "" : `, ${o.caller.behindDefault} behind the remote default (${o.defaultBranch})`}.`,
		);
	}
	if (o.preserved) {
		L.push(
			`  preserved: ${o.preserved.paths.join(", ") || "—"} ${o.preserved.restored ? "✓ restored" : "⚠ NOT restored (kept in stash)"}${o.preserved.conflict ? ` — ${o.preserved.conflict}` : ""}`,
		);
	}
	for (const w of o.warnings) L.push(`  ⚠ ${w}`);
	if (o.commands.length) {
		L.push("  commands:");
		for (const c of o.commands) L.push(`    $ ${c}`);
	}
	return L.join("\n");
}

/** Render a retrospect outcome: summary line, anomalies (warn/info), warnings,
 *  and the recorded commands (the recipe is read-only, so every command is too). */
function formatRetrospect(o: RetrospectOutcome): string {
	const L: string[] = [];
	L.push(`🔍 retrospect: ${o.summary}`);
	if (o.anomalies.length === 0) {
		L.push("  no anomalies detected.");
	} else {
		for (const a of o.anomalies) {
			L.push(`  ${a.severity === "warn" ? "⚠" : "ℹ"} [${a.kind}] ${a.message}`);
		}
	}
	for (const w of o.warnings) L.push(`  ⚠ ${w}`);
	if (o.commands.length) {
		L.push("  commands:");
		for (const c of o.commands) L.push(`    $ ${c}`);
	}
	return L.join("\n");
}

/** Render a prepare outcome: head line (complete/aborted), step ledger, warnings,
 *  and the mutating commands issued (or the dry-run plan). */
function formatPrepare(o: PrepareOutcome): string {
	const L: string[] = [];
	const head = o.aborted
		? `⛔ prepare_feature_branch ABORTED [${o.aborted.reason}]: ${o.aborted.message}${o.aborted.hint ? ` — ${o.aborted.hint}` : ""}`
		: `✅ prepare_feature_branch complete.`;
	L.push(`${head} branch=${o.branch || "?"}, base=${o.base || "?"}.`);
	for (const s of o.steps) {
		L.push(`  ${s.step}: ${s.ok ? "✓" : "✗"}`);
	}
	for (const w of o.warnings) L.push(`  ⚠ ${w}`);
	if (o.commands.length) {
		L.push("  commands:");
		for (const c of o.commands) L.push(`    $ ${c}`);
	}
	return L.join("\n");
}

/** Render a verify-merge outcome: verdict line (CLEAN/CONTAMINATED/UNVERIFIED/
 *  NOT-MERGED), out-of-scope files, warnings, and the commands issued.
 *  Only CLEAN gets ✅ — UNVERIFIED means the scope check never ran, which must
 *  not read like a pass (issue #1439). */
function formatVerifyMerge(o: VerifyMergeOutcome): string {
	const L: string[] = [];
	if (o.aborted) {
		L.push(`⛔ verify_merge_landed ABORTED [${o.aborted.reason}]: ${o.aborted.message}`);
	} else if (!o.merged) {
		L.push(`• verify_merge_landed: PR #${o.pr} not merged (state=${o.state}). verdict=${o.verdict}.`);
	} else {
		const icon = o.verdict === "CLEAN" ? "✅" : "⚠";
		L.push(
			`${icon} verify_merge_landed: PR #${o.pr} MERGED${o.mergeSha ? ` (${o.mergeSha.slice(0, 7)})` : ""} — ${o.fileCount} file(s), +${o.insertions}/-${o.deletions}. verdict=${o.verdict}.${o.branchSpent ? " branch spent." : " branch NOT spent."}`,
		);
		if (o.outOfScope.length) {
			L.push(`  out-of-scope (${o.outOfScope.length}): ${o.outOfScope.map((f) => f.path).join(", ")}`);
		}
	}
	for (const w of o.warnings) L.push(`  ⚠ ${w}`);
	if (o.commands.length) {
		L.push("  commands:");
		for (const c of o.commands) L.push(`    $ ${c}`);
	}
	return L.join("\n");
}

/**
 * Gate-Recall Guard probe sets (QA-DATA only — NOT part of the runtime
 * `gating` object). Consumed by s2-agent-ext-tool-gate/qa/collect-probes.ts.
 * devops registers EIGHT keyword-gated tool groups, so it exports EIGHT named
 * probe consts. Plain objects: no `satisfies` / type import, so this extension
 * never depends on tool-gate (avoids a circular dep); shape is enforced by
 * tool-gate's drift-guard test. Dispatch gates → controls-only (recallFloor 0,
 * adversarial []): narrow keywords are intentional, so we assert each
 * predicate fires on its own keywords, not paraphrased intent.
 */
export const PI_DEPLOY_PROBES = {
	gate: "deploy_pi_agent_sh",
	recallFloor: 0,
	adversarial: [],
	controls: ["build the s2-agent bundle", "deploy the extension", "打包 s2-agent"],
};
export const AWAIT_PR_MERGE_PROBES = {
	gate: "merge_pr_after_local_ci",
	recallFloor: 0,
	adversarial: [],
	controls: ["merge the pr", "ship the pull-request", "wait for pr merge"],
};
export const SWEEP_BRANCHES_PROBES = {
	gate: "sweep_merged_branches",
	recallFloor: 0,
	adversarial: [],
	controls: ["sweep stale branches", "prune and cleanup branches", "delete-branch remotely"],
};
export const LOCAL_CI_PROBES = {
	gate: "run_local_ci",
	recallFloor: 0,
	adversarial: [],
	controls: ["run local ci", "typecheck and test", "verify the gate is green"],
};
export const SYNC_REPO_PROBES = {
	gate: "sync_default_branch",
	recallFloor: 0,
	adversarial: [],
	controls: ["sync with origin/main", "fetch and rebase", "merge --ff-only", "git sync the repo", "update main to get latest changes", "bring main up to date with origin"],
};
export const DEVOPS_RETROSPECT_PROBES = {
	gate: "run_devops_retrospect",
	recallFloor: 0,
	adversarial: [],
	controls: ["run a retrospect", "review for anomalies", "reflect on the post-run"],
};
export const PREPARE_BRANCH_PROBES = {
	gate: "prepare_feature_branch",
	recallFloor: 0,
	adversarial: [],
	controls: ["prepare the branch", "rebase before force-push", "branch is behind, prepare it"],
};
export const MAIN_HEALTH_PROBES = {
	gate: "check_main_health",
	recallFloor: 0,
	adversarial: [],
	controls: ["is main green", "is the default branch broken", "check main health"],
};
export const VERIFY_MERGE_PROBES = {
	gate: "verify_merge_landed",
	recallFloor: 0,
	adversarial: [],
	controls: ["verify the merge scope", "check for contaminated merge", "verify spent correctly"],
};

export default function (pi: ExtensionAPI): void {
	if (process.env.BUN_PI_DEVOPS === "0") return;
	pi.registerTool({
		name: "merge_pr_after_local_ci",
		label: "Gate a GitHub PR on run_local_ci, then squash-merge",
		description:
			"Gate a GitHub PR on run_local_ci (offline typecheck+tests+quality-gates for the PR's changed packages vs its base), then squash-merge — no remote CI, no polling. Blocks (no merge) when run_local_ci fails OR detection errors OR the PR is BEHIND/non-CLEAN. Remote CI is disabled in this repo; this is the local proxy gate. Returns merged/blocked + a localCi breakdown.",
		gating: { gate: "merge_pr_after_local_ci" }, // reference form (ticket 01)
		promptSnippet: "Merge a PR: run run_local_ci over the PR's changed packages vs its base, then squash-merge when green + CLEAN. Blocks on red CI / BEHIND / non-CLEAN. No remote CI, no polling.",
		parameters: Type.Object({
			prNumber: Type.Integer({ description: "The PR number to merge." }),
			strategy: Type.Optional(
				Type.String({ description: "Merge strategy: 'squash' (default, matches the repo's gh-ship convention), 'merge', or 'rebase'." }),
			),
			deleteBranch: Type.Optional(Type.Boolean({ description: "Delete the branch on merge (default true)." })),
		}),
		async execute(_id, params, signal) {
			const spawn = createLiveSpawn(process.cwd());
			// Resolve the repo root WITHOUT chdir (no top-level cd) — fall back to
			// process.cwd() if not in a git worktree.
			const root = await spawn("git", ["rev-parse", "--show-toplevel"]);
			const repoRoot = root.exitCode === 0 ? root.stdout.trim() : process.cwd();
			const forge = await selectForgeClientCached({ spawn, repoRoot });
			const gh = forge.client;
			const strategy = (params.strategy === "merge" || params.strategy === "rebase" ? params.strategy : "squash") as
				| "rebase"
				| "merge"
				| "squash";
			const outcome = await runMergeRecipe({
				prNumber: params.prNumber as number,
				strategy,
				deleteBranch: params.deleteBranch !== false,
				gh,
				spawn,
				repoRoot,
				remoteName: forge.remoteName,
				signal,
			});
			const took = ` Took ${Math.round(outcome.elapsedMs / 1000)}s.`;
			const ciBlock = outcome.localCi ? `\n${formatCiOutcome(outcome.localCi)}` : "";
			const text = outcome.merged
				? `✅ PR #${params.prNumber} MERGED${outcome.mergeSha ? ` (${outcome.mergeSha.slice(0, 7)})` : ""} — run_local_ci green, squash-merged.${took}${ciBlock}`
				: outcome.finalState === "MERGED"
					? `✅ PR #${params.prNumber} was already MERGED${outcome.mergeSha ? ` (${outcome.mergeSha.slice(0, 7)})` : ""}.`
					: outcome.error?.startsWith("PR is behind base")
						? `⛔ PR #${params.prNumber} blocked (BEHIND): ${outcome.error}${ciBlock}`
						: outcome.error?.startsWith("merge blocked: mergeState=")
							? `⛔ PR #${params.prNumber} blocked (non-CLEAN mergeState): ${outcome.error}${ciBlock}`
							: outcome.localCi
								? `❌ PR #${params.prNumber} blocked on run_local_ci: ${outcome.error ?? "unknown"}.${took}${ciBlock}`
								: `❌ PR #${params.prNumber} not merged: ${outcome.error ?? "unknown"}.${took}`;
			return { details: outcome, content: [{ type: "text" as const, text }] };
		},
	});

	pi.registerTool({
		name: "show_pr_status",
		label: "Snapshot a GitHub PR's state + checks",
		description:
			"One-shot snapshot of a PR's merge state + CI check tally (pass/fail/pending). Lighter than merge_pr_after_local_ci when you only need to inspect, not merge. Wraps `gh pr view`/`gh pr checks` as structured JSON.",
		promptSnippet: "One-shot PR state + check tally (pass/fail/pending). Use instead of a bash gh loop when you only need to inspect.",
		parameters: Type.Object({
			prNumber: Type.Integer({ description: "The PR number to inspect." }),
		}),
		async execute(_id, params) {
			const gh = (await selectForgeClientCached({ spawn: createLiveSpawn(process.cwd()) })).client;
			const s = await gh.prStatus(params.prNumber as number);
			const c = `${s.checks.pass} pass / ${s.checks.fail} fail / ${s.checks.pending} pending`;
			const text = `PR #${params.prNumber}: state=${s.state}, mergeState=${s.mergeState}, checks=[${c}]${s.mergeSha ? `, mergeSha=${s.mergeSha.slice(0, 7)}` : ""}.`;
			return { details: s, content: [{ type: "text" as const, text }] };
		},
	});

	pi.registerTool({
		name: "sweep_merged_branches",
		label: "Sweep merged local + remote branches (conservative, dry-run by default)",
		description:
			"Classify every local + remote branch and report which are safe to delete. CONSERVATIVE: a branch is deleted only when gh shows a MERGED PR for it (high confidence); uncertain cases ([gone] without gh proof, or a head ref reused by an open PR) go to a `review` bucket the human decides — never auto-deleted. Worktree-checked-out, protected (main/master/default) and the current branch are NEVER deleted (absolute). Dry-run by default: returns the plan only; pass execute:true to delete the high-confidence set, or confirm:[...] to delete specific reviewed branches. Uses structured git/gh JSON — never `git branch --merged` (wrong for squash merges).",
		gating: { gate: "sweep_merged_branches" }, // reference form (ticket 01)
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
			const spawn = createLiveSpawn(process.cwd());
			// Sweep needs the git surface + the forge PR listing.
			const forge = await selectForgeClientCached({ spawn });
			// The selection's remote name scopes the git surface — under a
			// non-origin remote, remoteBranches/defaultBranch/deleteRemoteBranch
			// MUST follow it or the sweep silently sees nothing.
			const client = { ...createBranchClient(spawn, forge.remoteName), prList: forge.client.prList };
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

	pi.registerTool({
		name: "run_local_ci",
		label: "Local CI verification",
		description:
			"Run local CI — typecheck + tests scoped to the packages changed vs origin/main, plus EVERY step of the workflow's regression-gates job (file-size, lockfile, dep-direction, ADR citation, seam, routing, config-parity, ci-workflow, package-scripts, portability, determinism, …; info-only schema-cost). Returns a STRUCTURED pass/fail so you can self-verify before merge. OFFLINE (no network): change detection runs in-process (extension-native TS), the per-package command comes from the CI matrix, and the gate list is DERIVED from the same workflow — neither is hand-copied here — so a green run is the local proxy for a green remote run. Use to self-verify before merge; merge_pr_after_local_ci / merge should gate on this.",
		gating: { gate: "run_local_ci" }, // reference form (ticket 01)
		promptSnippet:
			"Local CI: typecheck + tests for changed packages vs origin/main, plus repo gates. Structured pass/fail, offline. Self-verify before `gh ship`.",
		parameters: Type.Object({
			baseRef: Type.Optional(
				Type.String({ description: "Base ref to diff against (default <remote>/main; remote = DEVOPS_REMOTE > git config devops.remote > origin). Must exist locally — runLocalCi stays offline (never auto-fetches)." }),
			),
			packages: Type.Optional(
				Type.Array(Type.String(), { description: "Explicit package list (bun-apps/<name>); skips change detection entirely." }),
			),
			all: Type.Optional(Type.Boolean({ description: "Run every bun-apps/* package (computeChangedPackages all:true)." })),
			strict: Type.Optional(
				Type.Boolean({
					description:
						"Also run the audits that have NO step in the CI workflow (check-workflow-patterns.mjs, verify-skills.ts). Default false = exactly the regression-gates job, no more and no less.",
				}),
			),
			includeGates: Type.Optional(Type.Boolean({ description: "Run the gate suite (default true)." })),
		}),
		async execute(_id, params, signal) {
			const spawn = createLiveSpawn(process.cwd());
			// Resolve the repo root WITHOUT chdir (no top-level cd) — fall back to
			// process.cwd() if not in a git worktree.
			const root = await spawn("git", ["rev-parse", "--show-toplevel"]);
			const repoRoot = root.exitCode === 0 ? root.stdout.trim() : process.cwd();
			const outcome = await runLocalCi({
				repoRoot,
				baseRef: params.baseRef as string | undefined,
				headRef: "HEAD",
				packages: params.packages as string[] | undefined,
				all: params.all === true,
				strict: params.strict === true,
				includeGates: params.includeGates === false ? false : true,
				spawn,
				// Only drives the DEFAULT base ref (DEVOPS_REMOTE > git config
				// devops.remote > origin — src/remote.ts).
				remoteName: await resolveRemoteName(spawn),
				signal,
			});
			return { details: outcome, content: [{ type: "text" as const, text: formatCiOutcome(outcome) }] };
		},
	});

	pi.registerTool({
		name: "check_main_health",
		label: "Is the default branch green right now?",
		description:
			"Run the FULL test matrix + the whole regression-gates suite against the default branch, in the worktree that actually has it checked out. run_local_ci is change-scoped and remote CI is disabled here, so a branch that avoids a broken package merges green forever and nothing reports that main itself is red — this is the missing health check. ABORTS (tests nothing, reports unhealthy) when no worktree holds the default branch: a tree is required because a suite runs against a working tree, not a ref. A dirty or behind tree still runs but the outcome carries a warning saying the verdict is about that tree, not exactly origin/<default>. Read-only: never checks out, syncs, or mutates anything.",
		gating: { gate: "check_main_health" }, // reference form (ticket 01)
		promptSnippet:
			"check_main_health: full matrix + gates against the default branch, run in the worktree that holds it. Read-only. Says which packages/gates are red on main — the thing change-scoped run_local_ci structurally cannot see.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			const spawn = createLiveSpawn(process.cwd());
			const remoteName = await resolveRemoteName(spawn);
			const client = createBranchClient(spawn, remoteName);
			const outcome = await runMainHealth({ client, spawn, remoteName, signal });
			return { details: outcome, content: [{ type: "text" as const, text: formatMainHealth(outcome) }] };
		},
	});

	 pi.registerTool({
		name: "sync_default_branch",
		label: "Sync this repo to latest default branch (TS port of sync-repo.sh)",
		description:
			"Sync this worktree/repo to the latest default branch. Modes: 'full' (default) — git fetch origin; auto-detect the default branch D via origin/HEAD; advance D to origin/<D> WORKTREE-AWARE (advance it in the worktree that holds D; only check it out here when free), then recursively sync submodules to their remote tips. By DEFAULT the advance uses `git merge --ff-only origin/<D>` — it REFUSES (aborts, reason 'divergent') when local <D> has divergent/unpushed commits, so it NEVER loses commits. Pass force:true to instead use `git reset --hard origin/<D>` (discards those divergent commits — explicit opt-in). 'rebase' — fetch + rebase the current branch onto origin/<D>. 'pull' — fetch + merge origin/<D> into the current branch (a real merge, never fast-forward). dryRun computes + returns the exact git commands without mutating. Pre-flight: a dirty tracked tree aborts mutating runs; unpushed commits are warned. Auto-managed hot files (default: .agents/memory/MEMORY.md) are stashed + restored across the advance instead of aborting; genuinely uncommitted work still aborts. rebase/pull on a DETACHED HEAD aborts 'detached_head' unless branch is passed — then the named branch is created (or attached) at the current HEAD and the sync proceeds ('auto' derives the name from the worktree folder suffix). Replaces the sync-repo.sh / git-remote-main-sync.sh / safe-sync.sh bash (agent-invoked only; no shell entry).",
		gating: { gate: "sync_default_branch" }, // reference form (ticket 01) — family in GATE_DEFS
		promptSnippet:
			"Sync this repo to latest default branch. full (default): fetch + advance default branch via merge --ff-only (worktree-aware; aborts on divergent unless force:true → reset --hard) + recursive submodules. rebase/pull: fetch + rebase/merge current branch onto origin/<default>. dryRun shows the plan. Dirty tree aborts.",
		parameters: Type.Object({
			mode: Type.Optional(
				Type.String({ description: "Sync mode: 'full' (default — advance default branch + submodules), 'rebase' (rebase current onto origin/<default>), or 'pull' (merge origin/<default> into current)." }),
			),
			dryRun: Type.Optional(Type.Boolean({ description: "Compute + return the exact git commands without mutating anything (default false)." })),
			force: Type.Optional(
				Type.Boolean({
					description:
						"full-mode only. When false (default), advance the default branch with `merge --ff-only` and REFUSE if it has divergent/unpushed commits (never loses commits). When true, use `reset --hard origin/<default>` (discards divergent commits) — explicit opt-in.",
				}),
			),
			preserve: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Paths (exact, or dir prefix ending in '/') whose uncommitted changes are auto-preserved across the advance (stashed before, restored after) instead of aborting dirty_tree. Default: ['.agents/memory/MEMORY.md'] (hermes auto-managed). Only the listed paths are preserved; ALL OTHER uncommitted tracked work still aborts dirty_tree. Pass [] to disable preserve entirely.",
				}),
			),
			branch: Type.Optional(
				Type.String({
					description:
						"rebase/pull only — detached-HEAD recovery. When the calling worktree is on a detached HEAD, create (or attach, when it already exists at the exact HEAD) this branch at the current HEAD instead of aborting 'detached_head', then proceed. 'auto' derives the name from the worktree folder suffix (video_generation__memory → 'memory'). Never resolves to the default branch; an existing branch at a different commit or a branch checked out elsewhere aborts.",
				}),
			),
		}),
		async execute(_id, params, signal) {
			// Bounded like the headless CLI: every git call (incl. the client's
			// fetch) inherits SYNC_DEFAULT_TIMEOUT_MS, so a stalled SSH transport
			// kills the command instead of hanging the tool forever.
			const spawn = withDefaultTimeout(createLiveSpawn(process.cwd()), SYNC_DEFAULT_TIMEOUT_MS);
			const remoteName = await resolveRemoteName(spawn);
			const client = createBranchClient(spawn, remoteName);
			// Resolve the repo root WITHOUT chdir (no top-level cd) — fall back to
			// process.cwd() if not in a git worktree (mirrors merge_pr_after_local_ci/run_local_ci).
			const root = await spawn("git", ["rev-parse", "--show-toplevel"]);
			const repoRoot = root.exitCode === 0 ? root.stdout.trim() : process.cwd();
			const rawMode = params.mode as string | undefined;
			const mode: SyncMode = rawMode === "rebase" || rawMode === "pull" ? rawMode : "full";
			const outcome = await runSync({ client, spawn, repoRoot, mode, dryRun: params.dryRun === true, force: params.force === true, branch: params.branch as string | undefined, preserve: params.preserve as string[] | undefined, remoteName, signal });
			return { details: outcome, content: [{ type: "text" as const, text: formatSync(outcome) }] };
		},
	});

	pi.registerTool({
		name: "run_devops_retrospect",
		label: "Advisory post-run retrospective (anomaly review)",
		description:
			"Advisory post-run retrospective: inspects recent git ops + branch/worktree/divergence state, flags anomalies (force-push, scope drift, worktree-conflict, dirty-tree, divergence). Advisory only — never blocks.",
		gating: { gate: "run_devops_retrospect" }, // reference form (ticket 01)
		promptSnippet:
			"Advisory retrospective after a mutating recipe: flags force-push / scope-drift / worktree-conflict / dirty-tree / divergence. Read-only, never blocks.",
		parameters: Type.Object({
			expectedScope: Type.Optional(
				Type.Array(Type.String(), { description: "Optional scope prefixes; recent touched paths outside ALL prefixes surface as a scope-drift anomaly." }),
			),
			lookback: Type.Optional(Type.Integer({ description: "How many reflog/log entries to scan (default 12)." })),
		}),
		async execute(_id, params, signal) {
			const spawn = createLiveSpawn(process.cwd());
			const client = createBranchClient(spawn);
			// Resolve the repo root WITHOUT chdir (no top-level cd) — fall back to
			// process.cwd() if not in a git worktree.
			const root = await spawn("git", ["rev-parse", "--show-toplevel"]);
			const repoRoot = root.exitCode === 0 ? root.stdout.trim() : process.cwd();
			const outcome = await runRetrospect({
				client,
				spawn,
				repoRoot,
				expectedScope: params.expectedScope as string[] | undefined,
				lookback: params.lookback as number | undefined,
				signal,
			});
			return { details: outcome, content: [{ type: "text" as const, text: formatRetrospect(outcome) }] };
		},
	});

	pi.registerTool({
		name: "prepare_feature_branch",
		label: "Worktree-aware branch prepare (create / rebase / force-push)",
		description:
			"Worktree-aware branch prepare: create off base, rebase onto base, and/or force-push-with-lease. Covers the BEHIND state merge_pr_after_local_ci blocks on; aborts cleanly on worktree-conflict or rebase-conflict.",
		gating: { gate: "prepare_feature_branch" }, // reference form (ticket 01)
		promptSnippet:
			"Prepare a branch worktree-safely: create off base, rebase onto base, and/or force-push-with-lease. Covers the BEHIND state; throw-free aborts on conflicts. dryRun shows the plan.",
		parameters: Type.Object({
			branch: Type.Optional(Type.String({ description: "Target branch. Default: the current branch." })),
			base: Type.Optional(Type.String({ description: "Rebase/create base. Default: <remote>/<defaultBranch> (remote = DEVOPS_REMOTE > git config devops.remote > origin)." })),
			create: Type.Optional(Type.Boolean({ description: "Create the branch off `base` (git checkout -b)." })),
			rebase: Type.Optional(Type.Boolean({ description: "Rebase the branch onto `base`." })),
			forcePush: Type.Optional(
				Type.Boolean({ description: "Force-push the branch (--force-with-lease). Default false (never force-pushes by accident)." }),
			),
			dryRun: Type.Optional(Type.Boolean({ description: "Compute + record commands; spawn ZERO mutations (default false)." })),
		}),
		async execute(_id, params, signal) {
			const spawn = createLiveSpawn(process.cwd());
			const remoteName = await resolveRemoteName(spawn);
			const client = createBranchClient(spawn, remoteName);
			// Resolve the repo root WITHOUT chdir (no top-level cd) — fall back to
			// process.cwd() if not in a git worktree.
			const root = await spawn("git", ["rev-parse", "--show-toplevel"]);
			const repoRoot = root.exitCode === 0 ? root.stdout.trim() : process.cwd();
			const outcome = await runPrepare({
				client,
				spawn,
				repoRoot,
				branch: params.branch as string | undefined,
				base: params.base as string | undefined,
				create: params.create as boolean | undefined,
				rebase: params.rebase as boolean | undefined,
				forcePush: params.forcePush as boolean | undefined,
				dryRun: params.dryRun as boolean | undefined,
				remoteName,
				signal,
			});
			return { details: outcome, content: [{ type: "text" as const, text: formatPrepare(outcome) }] };
		},
	});

	pi.registerTool({
		name: "verify_merge_landed",
		label: "Post-merge verify (merge state + scope + branch-spent)",
		description:
			"Post-merge verify: confirm the PR merged, inspect the merge commit's actual file scope (vs an optional expectedScope → CLEAN/CONTAMINATED), and whether the feature branch is spent. Pass allowFetch when calling right after a merge, or the sha will not be local and the verdict is UNVERIFIED. Replaces manual `git show --stat` verification.",
		gating: { gate: "verify_merge_landed" }, // reference form (ticket 01)
		promptSnippet:
			"Post-merge verify: confirm merged, inspect the merge's file scope (CLEAN/CONTAMINATED vs expectedScope), check branch-spent. Read-only.",
		parameters: Type.Object({
			pr: Type.Integer({ description: "The PR number to verify." }),
			expectedScope: Type.Optional(
				Type.Array(Type.String(), { description: "Optional scope entries; touched files outside ALL entries → CONTAMINATED. Entry forms: `x/**` any depth, `x/*` one segment, `x/` prefix, bare `x` exact-or-directory." }),
			),
			allowFetch: Type.Optional(
				Type.Boolean({
					description:
						"Allow one `git fetch origin <mergeSha>` when the merge commit is not local yet (the usual case right after a merge). Without it such a run reports UNVERIFIED instead of checking the scope.",
				}),
			),
		}),
		async execute(_id, params, signal) {
			const spawn = createLiveSpawn(process.cwd());
			const forge = await selectForgeClientCached({ spawn });
			const gh = forge.client;
			const client = createBranchClient(spawn, forge.remoteName);
			// Resolve the repo root WITHOUT chdir (no top-level cd) — fall back to
			// process.cwd() if not in a git worktree.
			const root = await spawn("git", ["rev-parse", "--show-toplevel"]);
			const repoRoot = root.exitCode === 0 ? root.stdout.trim() : process.cwd();
			const outcome = await runVerifyMerge({
				gh,
				client,
				spawn,
				repoRoot,
				pr: params.pr as number,
				expectedScope: params.expectedScope as string[] | undefined,
				allowFetch: params.allowFetch as boolean | undefined,
				remoteName: forge.remoteName,
				signal,
			});
			return { details: outcome, content: [{ type: "text" as const, text: formatVerifyMerge(outcome) }] };
		},
	});

	// ────────────────────────────────────────────────────────────────────
	// deploy_pi_agent_sh + verify_pi_agent_deploy — absorbed from the former standalone deploy
	// extension. Each tool keeps its OWN owner-declared gating keywords
	// verbatim (NOT conflated with the devops PR/merge keywords above); the
	// tools wrap src/deploy/run.ts + scripts/run-test.ts (single source of
	// truth) by SPAWNING them (src/deploy-run.ts resolves the source s2-agent
	// dir at runtime and fails closed outside the source repo) — importing the
	// pipeline here would fold its module-scope import.meta paths into the
	// shipped bundle, which the deploy relocatability gate rejects.
	// ────────────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "deploy_pi_agent_sh",
		// Owner-declared gating — migrated verbatim from the deploy extension
		// (was the {names:["deploy_pi_agent_sh","verify_pi_agent_deploy"]} gate). The SAME gating is
		// mirrored on verify_pi_agent_deploy so both activate together.
		gating: { gate: "deploy_pi_agent_sh" }, // reference form (ticket 01) — shared family (deploy_pi_agent_sh + verify_pi_agent_deploy)
		label: "Build & Deploy s2-agent Bundle",
		description:
			"Build a versioned s2-agent deploy: a minimal core plus independently built extension " +
			"packages under ext/, at <outRoot>/<version>/ (see bun-apps/s2-agent/src/registry-config.ts). " +
			"Returns the version, target dir, per-extension sizes, and whether `current` was repointed.",
		parameters: Type.Object({
			force: Type.Optional(
				Type.Boolean({ description: "Replace an existing version dir. Default: false.", default: false }),
			),
			noFreeze: Type.Optional(
				Type.Boolean({ description: "Skip chmod a-w (dev; bypasses the core cache). Default: false.", default: false }),
			),
			noCurrent: Type.Optional(
				Type.Boolean({ description: "Do not repoint <outRoot>/current. Default: false.", default: false }),
			),
		}),
		async execute(_id, params) {
			try {
				const r = await runDeploy({
					force: params.force ?? false,
					noFreeze: params.noFreeze ?? false,
					noCurrent: params.noCurrent ?? false,
				});
				const text = r.ok
					? `✓ deployed ${r.version} → ${r.target}\n` +
						`  core=${((r.coreBytes ?? 0) / 1e6).toFixed(1)}MB${r.coreCached ? " (cached)" : ""}, ` +
						`${r.extensions?.length ?? 0} extension(s)` +
						(r.currentUpdated ? ", current repointed" : "") +
						(r.pruned && r.pruned.length > 0 ? `, pruned ${r.pruned.join(", ")}` : "")
					: `✗ deploy failed\n${r.errorTail ?? ""}`;
				return {
					content: [{ type: "text" as const, text }],
					details: r,
					isError: r.ok ? undefined : true,
				};
			} catch (err) {
				return {
					content: [{ type: "text" as const, text: `Error: ${String((err as Error).message ?? err)}` }],
					details: { ok: false },
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "verify_pi_agent_deploy",
		// Owner-declared gating — mirrored from deploy_pi_agent_sh (same hardcoded gate).
		gating: { gate: "deploy_pi_agent_sh" }, // reference form (ticket 01) — shared family (deploy_pi_agent_sh + verify_pi_agent_deploy)
		label: "Verify s2-agent (run-test.ts tier)",
		description:
			"Run a s2-agent run-test.ts tier (quick|medium|full; default medium) and report per-step pass/fail. " +
			"full = medium plus the live local-LLM smoke and the sibling-package baseline. Returns steps, exit code, and a log path.",
		parameters: Type.Object({
			tier: Type.Optional(
				StringEnum(
					["quick", "medium", "full"] as const,
					{ description: "run-test.ts tier. Default: medium.", default: "medium" },
				),
			),
			bail: Type.Optional(Type.Boolean({ description: "Stop on first failure (--bail). Default: false.", default: false })),
		}),
		async execute(_id, params) {
			try {
				const r = await runVerify({
					tier: params.tier as "quick" | "medium" | "full" | undefined,
					bail: params.bail ?? false,
				});
				const stepLines = r.steps.map((s) => `  ${s.passed ? "✓" : "✗"} ${s.name} (${s.seconds}s)`).join("\n");
				const text =
					(r.ok ? "✓ verify passed" : "✗ verify failed") +
					` (tier=${r.tier}, exit=${r.exitCode})` +
					(stepLines ? `\n${stepLines}` : "") +
					(r.logPath ? `\nlog: ${r.logPath}` : "") +
					(r.errorTail ? `\n${r.errorTail}` : "");
				return {
					content: [{ type: "text" as const, text }],
					details: r,
					isError: r.ok ? undefined : true,
				};
			} catch (err) {
				return {
					content: [{ type: "text" as const, text: `Error: ${String((err as Error).message ?? err)}` }],
					details: { ok: false },
					isError: true,
				};
			}
		},
	});
}
