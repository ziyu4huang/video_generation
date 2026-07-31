/**
 * runMergeRecipe — the polling orchestration for `await_pr_merge`. Each poll:
 * read PR status → decide the next action (pure logic in pr-logic.ts) → perform
 * the I/O the action implies (enable auto-merge / rebase+force-push / wait) →
 * sleep → repeat until MERGED / fail / timeout.
 *
 * All I/O is behind the injectable `GhClient` + `Sleeper` + `clock` interfaces,
 * so the loop is fully testable with scripted fakes (no real gh/git/network).
 * The real `GhClient` (wrapping the `gh` CLI via Bun.spawn) lives in src/gh.ts.
 */
import { decideRecipeAction, type PrState, type MergeState, type CheckTally } from "./pr-logic.js";

/** Injectable gh/git operations. Real impl: src/gh.ts. Tests inject fakes. */
export interface GhClient {
	prStatus(n: number): Promise<{ state: PrState; mergeState: MergeState; checks: CheckTally; mergeSha?: string }>;
	enableAutoMerge(n: number, strategy: "rebase" | "merge" | "squash", deleteBranch: boolean): Promise<void>;
	rebaseAndForcePush(branch: string): Promise<void>;
}

export interface Sleeper {
	sleep(ms: number): Promise<void>;
}

export interface RecipeOptions {
	prNumber: number;
	strategy: "rebase" | "merge" | "squash";
	deleteBranch: boolean;
	handleBehind: "rebase-force-push" | "fail";
	timeoutMs: number;
	pollIntervalMs: number;
	/** The feature branch to rebase+force-push when BEHIND. */
	branch: string;
	gh: GhClient;
	sleeper: Sleeper;
	clock: { now(): number };
}

export interface RecipeOutcome {
	merged: boolean;
	finalState: PrState;
	mergeSha?: string;
	checks?: CheckTally;
	behind: boolean;
	timedOut: boolean;
	error?: string;
}

export async function runMergeRecipe(opts: RecipeOptions): Promise<RecipeOutcome> {
	const start = opts.clock.now();
	let lastState: PrState = "OPEN";
	let lastChecks: CheckTally | undefined;
	let behind = false;

	while (true) {
		if (opts.clock.now() - start >= opts.timeoutMs) {
			return { merged: false, finalState: lastState, checks: lastChecks, behind, timedOut: true };
		}

		const status = await opts.gh.prStatus(opts.prNumber);
		lastState = status.state;
		lastChecks = status.checks;
		const action = decideRecipeAction(status.state, status.mergeState, status.checks);

		switch (action.kind) {
			case "done":
				return {
					merged: true,
					finalState: "MERGED",
					mergeSha: status.mergeSha,
					checks: status.checks,
					behind,
					timedOut: false,
				};
			case "merge":
				await opts.gh.enableAutoMerge(opts.prNumber, opts.strategy, opts.deleteBranch);
				break;
			case "rebase":
				if (opts.handleBehind === "fail") {
					return {
						merged: false,
						finalState: status.state,
						checks: status.checks,
						behind: true,
						timedOut: false,
						error: "PR is BEHIND and handleBehind=fail",
					};
				}
				behind = true;
				await opts.gh.rebaseAndForcePush(opts.branch);
				break;
			case "wait":
				break; // keep polling
			case "fail":
				return {
					merged: false,
					finalState: status.state,
					checks: status.checks,
					behind,
					timedOut: false,
					error: action.reason,
				};
		}

		await opts.sleeper.sleep(opts.pollIntervalMs);
	}
}
