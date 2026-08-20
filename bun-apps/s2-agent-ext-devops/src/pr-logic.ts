/**
 * Domain types shared by the PR-merge tooling. These were once the home of the
 * pure polling decision logic (`decideRecipeAction`), but `merge_pr_after_local_ci` is
 * now a single-shot LOCAL-CI-GATED merge (src/recipe.ts `runMergeRecipe`) — no
 * poll loop, no check-tally branching — so the decision function is gone. The
 * types stay because `src/gh.ts` parsers + `GhClient.prStatus` speak them.
 *
 * (Renaming this file to e.g. `pr-types.ts` is deferred — the cross-file
 * churn isn't worth it; only the symbols matter.)
 */

export type PrState = "OPEN" | "MERGED" | "CLOSED";

/** GitHub `mergeStateStatus` values (gh pr view --json mergeStateStatus). */
export type MergeState =
	| "CLEAN" // mergeable, no conflicts
	| "BEHIND" // head is behind base; needs rebase
	| "BLOCKED" // mergeable state but a required review/check blocks
	| "UNKNOWN" // GitHub hasn't computed yet (transient)
	| "DIRTY" // merge conflict
	| "HAS_HOOKS" // mergeable but pre-merge hooks pending
	| "UNSTABLE"; // failing/expected-status checks but otherwise mergeable

/** CI check tally (gh pr checks) — surfaced by the `show_pr_status` tool. The merge
 *  recipe itself no longer consumes this (it gates on run_local_ci instead), but
 *  `show_pr_status` still reports it, so the type + parser remain. */
export type CheckTally = { pass: number; fail: number; pending: number };
