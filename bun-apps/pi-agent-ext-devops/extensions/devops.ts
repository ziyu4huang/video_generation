/**
 * DevOps extension — tool-based PR-merge lifecycle. All gh output is parsed
 * as STRUCTURED JSON (no `gh pr checks | grep -c` footguns); the full merge
 * recipe lives in tested code (src/).
 *
 * Tools:
 *   - await_pr_merge: a LOCAL-CI-GATED merge. Runs local_ci (offline
 *     typecheck+tests+gates over the PR's changed packages vs its base), then
 *     squash-merges when green + CLEAN. Blocks on red CI / detection error /
 *     BEHIND / non-CLEAN. No remote CI (disabled in this repo), no polling.
 *   - pr_status: one-shot PR snapshot (state + mergeState + check tally).
 *   - local_ci: OFFLINE local CI — typecheck + tests scoped to changed packages
 *     vs origin/main, plus repo gates. Structured pass/fail; self-verify before
 *     `gh ship` (await_pr_merge gates on this).
 *
 * Install: registered in bun-apps/pi-agent/run-dir/manifest.json (extensions[]).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createGhClient, createBranchClient } from "../src/gh.js";
import { createLiveSpawn } from "../src/spawn.js";
import { runMergeRecipe } from "../src/recipe.js";
import { runSweep, type SweepOutcome } from "../src/branch-recipe.js";
import { runLocalCi, type CiOutcome } from "../src/ci-recipe.js";
import { runSync, type SyncMode, type SyncOutcome } from "../src/sync-recipe.js";

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

/** Render a typecheck result: ✓ / ✗ / skip / –. */
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
		for (const p of o.packages) L.push(`  ${p.name}: test ${fmtTest(p.test)} (typecheck ${fmtTypecheck(p.typecheck)})`);
	}
	if (o.gates.length) {
		const pass = o.gates.filter((g) => g.exitCode === 0).length;
		const failed = o.gates.filter((g) => g.exitCode !== 0).map((g) => `${g.name}${g.blocking ? " (blocking)" : ""}`);
		L.push(`Gates: ${pass} pass / ${o.gates.length - pass} fail.${failed.length ? ` ✗ ${failed.join(", ")}` : ""}`);
	}
	if (o.schemaCost) {
		L.push(`Schema-cost: ${o.schemaCost.exitCode === 0 ? "✓" : `✗ exit ${o.schemaCost.exitCode}`} (${o.schemaCost.note}).`);
	}
	return L.join("\n");
}

/** Render a sync_repo outcome: status line, advancements, submodule report,
 *  warnings, and the full command list (the primary output under dryRun). */
function formatSync(o: SyncOutcome): string {
	const L: string[] = [];
	const head = o.aborted
		? `⛔ sync_repo (${o.mode}) ABORTED [${o.aborted.reason}]: ${o.aborted.message}${o.aborted.hint ? ` — ${o.aborted.hint}` : ""}`
		: o.dryRun
			? `🔍 sync_repo (${o.mode}) DRY-RUN — no mutations performed.`
			: `✅ sync_repo (${o.mode}) complete.`;
	L.push(`${head} default=${o.defaultBranch || "?"}.`);
	for (const a of o.advanced) {
		L.push(`  advanced ${a.branch} @ ${a.worktree}: ${a.from.slice(0, 7)} → ${a.to.slice(0, 7)}`);
	}
	if (o.submodules.length) {
		const dirty = o.submodules.filter((s) => !s.clean).length;
		L.push(`  submodules: ${o.submodules.length} (${dirty} not-clean).`);
	}
	for (const w of o.warnings) L.push(`  ⚠ ${w}`);
	if (o.commands.length) {
		L.push("  commands:");
		for (const c of o.commands) L.push(`    $ ${c}`);
	}
	return L.join("\n");
}

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "await_pr_merge",
		label: "Gate a GitHub PR on local_ci, then squash-merge",
		description:
			"Gate a GitHub PR on local_ci (offline typecheck+tests+quality-gates for the PR's changed packages vs its base), then squash-merge — no remote CI, no polling. Blocks (no merge) when local_ci fails OR detection errors OR the PR is BEHIND/non-CLEAN. Remote CI is disabled in this repo; this is the local proxy gate. Returns merged/blocked + a localCi breakdown.",
		gating: { keywords: ["pr", "pull-request", "merge", "merged", "ship", "gate", "local ci", "devops"] },
		promptSnippet: "Merge a PR: run local_ci over the PR's changed packages vs its base, then squash-merge when green + CLEAN. Blocks on red CI / BEHIND / non-CLEAN. No remote CI, no polling.",
		parameters: Type.Object({
			prNumber: Type.Integer({ description: "The PR number to merge." }),
			strategy: Type.Optional(
				Type.String({ description: "Merge strategy: 'squash' (default, matches the repo's gh-ship convention), 'merge', or 'rebase'." }),
			),
			deleteBranch: Type.Optional(Type.Boolean({ description: "Delete the branch on merge (default true)." })),
		}),
		async execute(_id, params, signal) {
			const spawn = createLiveSpawn(process.cwd());
			const gh = createGhClient(spawn);
			// Resolve the repo root WITHOUT chdir (no top-level cd) — fall back to
			// process.cwd() if not in a git worktree.
			const root = await spawn("git", ["rev-parse", "--show-toplevel"]);
			const repoRoot = root.exitCode === 0 ? root.stdout.trim() : process.cwd();
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
				signal,
			});
			const took = ` Took ${Math.round(outcome.elapsedMs / 1000)}s.`;
			const ciBlock = outcome.localCi ? `\n${formatCiOutcome(outcome.localCi)}` : "";
			const text = outcome.merged
				? `✅ PR #${params.prNumber} MERGED${outcome.mergeSha ? ` (${outcome.mergeSha.slice(0, 7)})` : ""} — local_ci green, squash-merged.${took}${ciBlock}`
				: outcome.finalState === "MERGED"
					? `✅ PR #${params.prNumber} was already MERGED${outcome.mergeSha ? ` (${outcome.mergeSha.slice(0, 7)})` : ""}.`
					: outcome.error?.startsWith("PR is behind base")
						? `⛔ PR #${params.prNumber} blocked (BEHIND): ${outcome.error}${ciBlock}`
						: outcome.error?.startsWith("merge blocked: mergeState=")
							? `⛔ PR #${params.prNumber} blocked (non-CLEAN mergeState): ${outcome.error}${ciBlock}`
							: outcome.localCi
								? `❌ PR #${params.prNumber} blocked on local_ci: ${outcome.error ?? "unknown"}.${took}${ciBlock}`
								: `❌ PR #${params.prNumber} not merged: ${outcome.error ?? "unknown"}.${took}`;
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
			const gh = createGhClient(createLiveSpawn(process.cwd()));
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
			const spawn = createLiveSpawn(process.cwd());
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

	pi.registerTool({
		name: "local_ci",
		label: "Local CI verification",
		description:
			"Run local CI — typecheck + tests scoped to the packages changed vs origin/main, plus the repo's quality gates (file-size guard, lockfile-duplicate guard; optional audit gates under strict; info-only schema-cost). Returns a STRUCTURED pass/fail so you can self-verify before merge. OFFLINE (no network): change detection runs in-process (extension-native TS) and the gate suite uses the same committed scripts remote CI uses (scripts/ci-file-size-guard.sh, …), so a green run is the local proxy for a green remote run. Use to self-verify before merge; await_pr_merge / merge should gate on this.",
		gating: { keywords: ["ci", "test", "typecheck", "verify", "gate", "green", "merge", "local ci"] },
		promptSnippet:
			"Local CI: typecheck + tests for changed packages vs origin/main, plus repo gates. Structured pass/fail, offline. Self-verify before `gh ship`.",
		parameters: Type.Object({
			baseRef: Type.Optional(
				Type.String({ description: "Base ref to diff against (default origin/main). Must exist locally — runLocalCi stays offline (never auto-fetches)." }),
			),
			packages: Type.Optional(
				Type.Array(Type.String(), { description: "Explicit package list (bun-apps/<name>); skips change detection entirely." }),
			),
			all: Type.Optional(Type.Boolean({ description: "Run every bun-apps/* package (computeChangedPackages all:true)." })),
			strict: Type.Optional(
				Type.Boolean({ description: "Add the audit gates (determinism / portability / workflow-patterns / verify-skills). Default false." }),
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
				signal,
			});
			return { details: outcome, content: [{ type: "text" as const, text: formatCiOutcome(outcome) }] };
		},
	});

	 pi.registerTool({
		name: "sync_repo",
		label: "Sync this repo to latest default branch (TS port of sync-repo.sh)",
		description:
			"Sync this worktree/repo to the latest default branch. Modes: 'full' (default) — git fetch origin; auto-detect the default branch D via origin/HEAD; advance D to origin/<D> WORKTREE-AWARE (advance it in the worktree that holds D; only check it out here when free), then recursively sync submodules to their remote tips. By DEFAULT the advance uses `git merge --ff-only origin/<D>` — it REFUSES (aborts, reason 'divergent') when local <D> has divergent/unpushed commits, so it NEVER loses commits. Pass force:true to instead use `git reset --hard origin/<D>` (discards those divergent commits — explicit opt-in). 'rebase' — fetch + rebase the current branch onto origin/<D>. 'pull' — fetch + merge origin/<D> into the current branch (a real merge, never fast-forward). dryRun computes + returns the exact git commands without mutating. Pre-flight: a dirty tracked tree aborts mutating runs; unpushed commits are warned. Replaces the sync-repo.sh / git-remote-main-sync.sh / safe-sync.sh bash (agent-invoked only; no shell entry).",
		gating: { keywords: ["sync", "fetch", "rebase", "pull", "default branch", "origin/main", "origin/master", "submodule", "reset --hard", "merge --ff-only", "fast-forward", "ff-only", "force", "devops"] },
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
		}),
		async execute(_id, params, signal) {
			const spawn = createLiveSpawn(process.cwd());
			const client = createBranchClient(spawn);
			// Resolve the repo root WITHOUT chdir (no top-level cd) — fall back to
			// process.cwd() if not in a git worktree (mirrors await_pr_merge/local_ci).
			const root = await spawn("git", ["rev-parse", "--show-toplevel"]);
			const repoRoot = root.exitCode === 0 ? root.stdout.trim() : process.cwd();
			const rawMode = params.mode as string | undefined;
			const mode: SyncMode = rawMode === "rebase" || rawMode === "pull" ? rawMode : "full";
			const outcome = await runSync({ client, spawn, repoRoot, mode, dryRun: params.dryRun === true, force: params.force === true, signal });
			return { details: outcome, content: [{ type: "text" as const, text: formatSync(outcome) }] };
		},
	});
}
