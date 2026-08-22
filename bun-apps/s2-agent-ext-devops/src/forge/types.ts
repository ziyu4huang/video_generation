/**
 * forge/types.ts — the forge-agnostic client contract.
 *
 * A "forge" is a git hosting service (GitHub, Gitea/Forgejo, …). This module
 * defines the NORMALIZED surface the devops recipes consume; per-forge
 * adapters implement it (github-rest.ts, gh-cli.ts, gitea.ts). Design follows
 * Renovate's Platform split:
 * PR/merge/check operations live behind this interface; ALL git operations
 * (fetch/push/branch/worktree) stay in BranchClient (src/gh.ts) — git is
 * forge-agnostic by nature and never goes through a forge adapter.
 *
 * The normalized types are the ones pr-logic.ts already defines (PrState /
 * MergeState / CheckTally) — no parallel enum ladder. Adapters translate
 * forge-specific payloads into these (e.g. GitHub REST `mergeable_state`
 * values map onto MergeState; Gitea maps its boolean `mergeable` + commit
 * statuses instead).
 */
import type { PrState, MergeState, CheckTally } from "../pr-logic.js";

/** One PR snapshot — the union of what prStatus consumers (merge recipe,
 *  show_pr_status, verify_merge_landed) read. */
export interface PrSnapshot {
	state: PrState;
	mergeState: MergeState;
	baseRefName: string;
	headRefName: string;
	/** Check tally (used by the show_pr_status tool; the merge recipe ignores it). */
	checks: CheckTally;
	mergeSha?: string;
	/** The head ref's SHA — what was merged. Lets verify_merge_landed tell a spent
	 *  branch from one with commits pushed after the merge. */
	headRefOid?: string;
}

/** Merge strategies, in gh-CLI spelling (the historical contract). GitHub REST
 *  uses the same tokens (`merge_method`); Gitea's `Do` parameter maps
 *  `rebase-merge` ↔ `rebase` and adds `fast-forward-only` (no equivalent here). */
export type MergeStrategy = "rebase" | "merge" | "squash";

/**
 * The forge client contract. `GhClient` (src/recipe.ts) is a type alias of
 * this interface — the historical name stays importable so recipes, CLIs, and
 * their fake-injecting tests are untouched by the forge refactor.
 *
 * Error discipline (both existing consumers rely on it):
 * - prStatus NEVER throws on odd payloads — it normalizes defensively
 *   (unknown/garbage → OPEN/UNKNOWN + empty refs), mirroring parsePrView.
 * - mergeNow THROWS on failure with the full forge response text embedded in
 *   the message (merge-pr-after-ci's isMissingWorkflowScope greps the message
 *   to classify gh workflow-scope refusals — REST adapters must keep the
 *   response body in the error text for the same classification to work).
 */
/** One row of a PR listing — the shape sweep_merged_branches consumes. */
export interface PrListRow {
	number: number;
	headRefName: string;
	/** ISO merge timestamp — present iff the PR is merged. */
	mergedAt?: string;
}

export interface ForgeClient {
	prStatus(n: number): Promise<PrSnapshot>;
	/**
	 * Direct (synchronous) merge — NO auto-enable polling. Used once the
	 * run_local_ci gate is green + mergeState is CLEAN: the merge completes
	 * here, so success IS the confirmation (no remote CI to wait on). Throws
	 * on failure with the forge response text embedded.
	 */
	mergeNow(n: number, strategy: MergeStrategy, deleteBranch: boolean): Promise<void>;
	/**
	 * List PRs by coarse state. `merged` returns ONLY merged PRs (rows carry
	 * mergedAt); `open` returns open PRs. Capped at `limit` (default 200 —
	 * sweep's historical gh --limit). Formerly BranchClient.mergedPrRefs /
	 * .openPrRefs; moved here because a PR listing is a FORGE query, not a git
	 * operation (the Renovate Platform/PlatformScm split this module follows).
	 */
	prList(state: "open" | "merged", limit?: number): Promise<PrListRow[]>;
}
