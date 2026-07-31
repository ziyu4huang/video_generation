/**
 * PURE merge-recipe decision logic (no I/O). The heart of `await_pr_merge`:
 * given the current PR state + check tally, decide the next action. Kept pure
 * (no gh/git/clock) so it's fully testable without external services.
 *
 * The full recipe is orchestrated by `runMergeRecipe` (src/recipe.ts), which
 * calls this each poll + performs the I/O the action implies.
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

export type CheckTally = { pass: number; fail: number; pending: number };

export type RecipeAction =
	| { kind: "done" } // MERGED — stop, success
	| { kind: "merge" } // checks pass + mergeable → enable auto-merge
	| { kind: "rebase" } // BEHIND at 0 pending → rebase + force-push (CI reruns)
	| { kind: "wait" } // pending checks OR transient UNKNOWN
	| { kind: "fail"; reason: string }; // checks failed / blocked / closed

/**
 * Decide the next recipe action from the observed PR state. Order matters:
 * terminal states first (MERGED/CLOSED), then check failures, then pending,
 * then the BEHIND/CLEAN/UNKNOWN mergeability cases. BLOCKED/DIRTY/etc. are
 * not auto-resolvable → fail with the reason.
 */
export function decideRecipeAction(
	state: PrState,
	mergeState: MergeState,
	checks: CheckTally,
): RecipeAction {
	if (state === "MERGED") return { kind: "done" };
	if (state === "CLOSED") return { kind: "fail", reason: "PR closed without merging" };
	if (checks.fail > 0) return { kind: "fail", reason: `${checks.fail} check(s) failing` };
	if (checks.pending > 0) return { kind: "wait" };
	// All checks done, none failing — decide by mergeability.
	if (mergeState === "BEHIND") return { kind: "rebase" };
	if (mergeState === "CLEAN") return { kind: "merge" };
	if (mergeState === "UNKNOWN") return { kind: "wait" }; // transient — let GitHub settle
	return { kind: "fail", reason: `merge blocked: ${mergeState}` };
}
