/**
 * Pure progress formatting for `await_pr_merge`'s live TUI status. Turns a
 * ProgressUpdate (one poll's snapshot from runMergeRecipe) into a single
 * one-line status that the TUI rewrites each poll via the tool's onUpdate.
 *
 * Pure (no I/O) so it's fully unit-testable. Mirrors the subagent tool's
 * formatSubagentProgress pattern.
 */
import type { RecipeAction } from "./pr-logic.js";
import type { ProgressUpdate } from "./recipe.js";

const ACTION_SUFFIX: Record<RecipeAction["kind"], string> = {
	wait: "CI running…",
	merge: "checks green → auto-merge armed",
	rebase: "BEHIND → rebasing + force-pushing…",
	done: "merged ✓",
	fail: "not mergeable",
};

/** Format one poll's snapshot as a live one-line TUI status. */
export function formatProgress(u: ProgressUpdate): string {
	const sec = Math.max(0, Math.floor(u.elapsedMs / 1000));
	const tally = `${u.checks.pass}/${u.checks.fail}/${u.checks.pending}`;
	return `⏳ PR #${u.prNumber} · ${sec}s · poll ${u.pollNumber} · checks ${tally} · ${ACTION_SUFFIX[u.action]}`;
}
