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
import { decideRecipeAction, type PrState, type MergeState, type CheckTally, type RecipeAction } from "./pr-logic.js";

/** Injectable gh/git operations. Real impl: src/gh.ts. Tests inject fakes. */
export interface GhClient {
	prStatus(n: number): Promise<{ state: PrState; mergeState: MergeState; checks: CheckTally; mergeSha?: string }>;
	enableAutoMerge(n: number, strategy: "rebase" | "merge" | "squash", deleteBranch: boolean): Promise<void>;
	rebaseAndForcePush(branch: string): Promise<void>;
}

export interface Sleeper {
	sleep(ms: number): Promise<void>;
}

/** One poll's snapshot, handed to `onProgress` for live TUI updates. */
export interface ProgressUpdate {
	prNumber: number;
	pollNumber: number;
	elapsedMs: number;
	state: PrState;
	mergeState: MergeState;
	checks: CheckTally;
	action: RecipeAction["kind"];
	behind: boolean;
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
	/** Optional abort signal — the loop stops + returns aborted when fired. */
	signal?: AbortSignal;
	/** Optional live-progress callback — invoked once per poll with the observed state. */
	onProgress?: (update: ProgressUpdate) => void;
}

export interface RecipeOutcome {
	merged: boolean;
	finalState: PrState;
	mergeSha?: string;
	checks?: CheckTally;
	behind: boolean;
	timedOut: boolean;
	aborted?: boolean;
	elapsedMs: number;
	error?: string;
}

export async function runMergeRecipe(opts: RecipeOptions): Promise<RecipeOutcome> {
	const t0 = opts.clock.now();
	const result = await runRecipeLoop(opts);
	return { ...result, elapsedMs: opts.clock.now() - t0 };
}

/** Inner poll loop — returns everything except elapsedMs (stamped once by the wrapper). */
async function runRecipeLoop(opts: RecipeOptions): Promise<Omit<RecipeOutcome, "elapsedMs">> {
	const start = opts.clock.now();
	let lastState: PrState = "OPEN";
	let lastChecks: CheckTally | undefined;
	let behind = false;
	let pollNumber = 0;

	while (true) {
		if (opts.signal?.aborted) {
			return { merged: false, finalState: lastState, checks: lastChecks, behind, timedOut: false, aborted: true };
		}
		if (opts.clock.now() - start >= opts.timeoutMs) {
			return { merged: false, finalState: lastState, checks: lastChecks, behind, timedOut: true };
		}

		const status = await opts.gh.prStatus(opts.prNumber);
		lastState = status.state;
		lastChecks = status.checks;
		const action = decideRecipeAction(status.state, status.mergeState, status.checks);
		pollNumber += 1;
		opts.onProgress?.({
			prNumber: opts.prNumber,
			pollNumber,
			elapsedMs: opts.clock.now() - start,
			state: status.state,
			mergeState: status.mergeState,
			checks: status.checks,
			action: action.kind,
			behind,
		});

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
				// RCA #1009: a rebase/force-push failure (dirty tree, conflict, rejected
				// push) must surface as a clean error outcome — not throw (which
				// crashes the tool) and not spin silently (which the harness eventually
				// aborts as a misleading "aborted").
				try {
					await opts.gh.rebaseAndForcePush(opts.branch);
				} catch (err) {
					return {
						merged: false,
						finalState: status.state,
						checks: status.checks,
						behind: true,
						timedOut: false,
						error: `BEHIND rebase+force-push failed: ${err instanceof Error ? err.message : String(err)}`,
					};
				}
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
