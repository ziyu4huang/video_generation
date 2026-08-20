/**
 * PURE branch-classification logic (no I/O). The heart of `sweep_merged_branches`:
 * given the observed signals for one branch, decide its confidence tier +
 * bucket. Kept pure (no gh/git) so it's fully testable without external services.
 *
 * CONSERVATIVE by design:
 *  - delete only on POSITIVE gh merge evidence (mergedPr), with no open-PR
 *    name conflict;
 *  - `[gone]` (remote deleted) is a HINT, never proof → low/review, not delete;
 *  - guards are absolute: worktree-locked / protected / current → always keep.
 *
 * `contained` (branch fully in default via `--merged`) is carried as info-only
 * corroboration; it does not change the tier (squash repos rarely set it, and
 * mergedPr is already authoritative).
 *
 * The full plan/execute orchestration lives in src/branch-recipe.ts, which
 * routes a `delete` verdict to deleteLocal vs deleteRemote by `kind`.
 */

export type BranchKind = "local" | "remote";

export type Confidence = "high" | "medium" | "low" | "none";

/** Outcome bucket. `delete` is routed to deleteLocal/deleteRemote by `kind`. */
export type Bucket = "delete" | "review" | "keep";

export interface BranchInput {
	kind: BranchKind;
	/** S1: gh shows a MERGED PR for this head ref (authoritative). */
	mergedPr: boolean;
	/** S2: remote-tracking ref is [gone] (remote deleted — hint, ambiguous). */
	gone: boolean;
	/** S3: branch fully contained in the default branch via --merged (info-only). */
	contained: boolean;
	/** S4: an OPEN PR reuses this head ref (CONFLICT — lowers confidence). */
	openPr: boolean;
	/** Absolute guard: checked out in a worktree → never deleted. */
	inWorktree: boolean;
	/** Guard: protected name (main/master/default). */
	isProtected: boolean;
	/** Guard: currently checked out (HEAD). */
	isCurrent: boolean;
}

export interface BranchVerdict {
	confidence: Confidence;
	bucket: Bucket;
	reason: string;
}

/**
 * Decide a branch's {confidence, bucket, reason} from its signals.
 *
 * Order matters — guards first (absolute), then the merged/open/gone matrix:
 *   merged + open    → medium/review  (name reused — human confirms which)
 *   merged + !open   → high/delete    (gh-confirmed merge)
 *   !merged + open   → keep           (active branch, in use)
 *   !merged + gone   → low/review     (remote deleted, merge unverifiable)
 *   !merged + !gone  → keep           (no merge evidence)
 */
export function classifyBranch(b: BranchInput): BranchVerdict {
	// 1. Absolute guards (checked first, in priority order).
	if (b.inWorktree) return { confidence: "none", bucket: "keep", reason: "worktree-locked" };
	if (b.isProtected) return { confidence: "none", bucket: "keep", reason: "protected" };
	if (b.isCurrent) return { confidence: "none", bucket: "keep", reason: "current" };

	// 2. Positive merge evidence present.
	if (b.mergedPr) {
		if (b.openPr) return { confidence: "medium", bucket: "review", reason: "merged but an open PR reuses the ref" };
		return { confidence: "high", bucket: "delete", reason: "gh-confirmed merge" };
	}

	// 3. No merge evidence: active branches stay, [gone] is a hint → review.
	if (b.openPr) return { confidence: "none", bucket: "keep", reason: "active (open PR)" };
	if (b.gone) return { confidence: "low", bucket: "review", reason: "remote deleted, merge unverifiable" };
	return { confidence: "none", bucket: "keep", reason: "no merge evidence" };
}
