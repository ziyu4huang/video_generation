/**
 * runMergeRecipe — a LOCAL-CI-GATED merge for `merge_pr_after_local_ci`. Remote CI is
 * intentionally DISABLED in this repo (`.github/workflows/ci.yml.disabled`),
 * so there is nothing to poll: this is a single-shot gate+merge.
 *
 *   1. `gh pr view` → {state, mergeState, baseRefName, headRefName}.
 *   2. state==="MERGED" → merged:true (already merged). state!=="OPEN"
 *      (CLOSED…) → block.
 *   3. Best-effort `git fetch origin <base> <head>` (offline-safe — exit code
 *      IGNORED; a failed/offline fetch just means run_local_ci will then error on
 *      a missing ref and we block fail-closed). The tool never hard-fails on
 *      the fetch itself.
 *   4. runLocalCi(base=origin/<base>, head=origin/<head>, strict:false,
 *      includeGates:true). This is the local proxy for remote CI: typecheck +
 *      tests scoped to the PR's changed packages vs its fetched base, plus the
 *      repo's quality gates.
 *   5. ci.overall !== "pass" (includes detectionError) → BLOCK: no merge.
 *   6. ci green: mergeState==="BEHIND" → block (NO auto-rebase — rebase
 *      locally + re-push, then re-run). mergeState!=="CLEAN" → block.
 *      mergeState==="CLEAN" → `gh pr merge --<strategy>` (+--delete-branch).
 *
 * All I/O is behind the injectable `GhClient` + `SpawnFn` seams, so it's fully
 * testable with fakes — mirroring how `runLocalCi` is tested with an injected
 * recording spawn. Elapsed is stamped with Date.now() at entry/exit.
 */
import type { SpawnFn } from "./spawn.js";
import type { CiOutcome } from "./ci-recipe.js";
import { runLocalCi } from "./ci-recipe.js";
import type { ComputeChangedPackagesOptions, ChangedPackagesMap } from "./changed-packages.js";
import type { CiGatesResult } from "./ci-gates.js";
import type { ForgeClient } from "./forge/types.js";

/**
 * Injectable forge/git operations. Historical name kept as an alias of the
 * forge-agnostic `ForgeClient` (src/forge/types.ts) — real impls come from
 * src/forge/select.ts (GitHub REST first, gh CLI fallback); tests inject
 * fakes. Only the name is gh-flavored; the contract is forge-neutral.
 */
export type GhClient = ForgeClient;

export interface RecipeOptions {
	prNumber: number;
	strategy: "rebase" | "merge" | "squash";
	deleteBranch: boolean;
	gh: GhClient;
	spawn: SpawnFn;
	repoRoot: string;
	signal?: AbortSignal;
	/**
	 * Injectable changed-package detector forwarded to runLocalCi. Default:
	 * `computeChangedPackages` (extension-native TS port of the former
	 * ci-changed-packages.sh). Tests inject a fake so the recipe stays fs-free.
	 */
	detectChangedPackages?: (opts: ComputeChangedPackagesOptions) => Promise<ChangedPackagesMap>;
	/**
	 * Injectable `regression-gates` reader forwarded to runLocalCi. Default:
	 * parse the job out of the workflow. Tests inject a fake so the recipe stays
	 * fs-free — and so a fake repoRoot doesn't fail the merge on a gate-read error.
	 */
	readGates?: (repoRoot: string) => Promise<CiGatesResult>;
	/** Remote name for the best-effort fetch + `origin/<ref>` CI refs (default
	 *  `origin`; resolve via src/remote.ts and pass down). */
	remoteName?: string;
}

export interface RecipeOutcome {
	merged: boolean;
	finalState: string;
	mergeSha?: string;
	localCi?: CiOutcome;
	elapsedMs: number;
	error?: string;
}

export async function runMergeRecipe(opts: RecipeOptions): Promise<RecipeOutcome> {
	const t0 = Date.now();
	const { prNumber, strategy, deleteBranch, gh, spawn, repoRoot, signal } = opts;
	const elapsed = () => Date.now() - t0;

	if (signal?.aborted) {
		return { merged: false, finalState: "OPEN", elapsedMs: elapsed(), error: "aborted before start" };
	}

	// 1. PR snapshot.
	let status;
	try {
		status = await gh.prStatus(prNumber);
	} catch (err) {
		return { merged: false, finalState: "OPEN", elapsedMs: elapsed(), error: `gh pr view failed: ${errMsg(err)}` };
	}

	// 2. Terminal states.
	if (status.state === "MERGED") {
		return { merged: true, finalState: "MERGED", mergeSha: status.mergeSha, elapsedMs: elapsed() };
	}
	if (status.state !== "OPEN") {
		return { merged: false, finalState: status.state, elapsedMs: elapsed(), error: `PR is ${status.state} (not OPEN)` };
	}

	// 3. Best-effort fetch of the PR's base+head refs (offline-safe). A failed
	//    /offline fetch is fine — run_local_ci then surfaces a missing-ref error
	//    (a thrown rev-parse on the base, or a detectionError on the diff) and
	//    we block fail-closed. Do NOT hard-fail the tool on the fetch itself.
	try {
		await spawn("git", ["fetch", opts.remoteName ?? "origin", status.baseRefName, status.headRefName], { cwd: repoRoot });
	} catch {
		/* best-effort — a throw here is unexpected (spawn returns a result, it
		 * doesn't throw), but guard anyway so the tool never crashes on it. */
	}

	// 4. Local-CI gate over the PR's fetched base..head. runLocalCi THROWS when
	//    even the base ref can't be resolved (fully offline + never fetched) —
	//    catch that and block fail-closed rather than crashing the tool.
	let ci: CiOutcome;
	try {
		ci = await runLocalCi({
			repoRoot,
			baseRef: `${opts.remoteName ?? "origin"}/${status.baseRefName}`,
			headRef: `${opts.remoteName ?? "origin"}/${status.headRefName}`,
			strict: false,
			includeGates: true,
			spawn,
			signal,
			detectChangedPackages: opts.detectChangedPackages,
			readGates: opts.readGates,
		});
	} catch (err) {
		return {
			merged: false,
			finalState: status.state,
			elapsedMs: elapsed(),
			error: `run_local_ci could not run: ${errMsg(err)}`,
		};
	}

	// 5. Gate failed (incl. detectionError) → BLOCK (no merge).
	if (ci.overall !== "pass") {
		const error = ci.detectionError ?? "run_local_ci failed; see packages/gates";
		return { merged: false, finalState: status.state, localCi: ci, elapsedMs: elapsed(), error };
	}

	// 6. Gate green → decide by mergeability (NO auto-rebase; NO escape hatch).
	if (status.mergeState === "BEHIND") {
		return {
			merged: false,
			finalState: status.state,
			localCi: ci,
			elapsedMs: elapsed(),
			error: "PR is behind base; rebase locally + re-push, then re-run merge_pr_after_local_ci.",
		};
	}
	if (status.mergeState !== "CLEAN") {
		return {
			merged: false,
			finalState: status.state,
			localCi: ci,
			elapsedMs: elapsed(),
			error: `merge blocked: mergeState=${status.mergeState} (expected CLEAN).`,
		};
	}

	// CLEAN + green → merge (synchronous, no --auto). Success IS the
	// confirmation — there's no remote CI to wait on.
	try {
		await gh.mergeNow(prNumber, strategy, deleteBranch);
	} catch (err) {
		return {
			merged: false,
			finalState: status.state,
			localCi: ci,
			elapsedMs: elapsed(),
			error: `gh pr merge failed: ${errMsg(err)}`,
		};
	}

	// Best-effort mergeSha via a follow-up pr view (the PR should now be MERGED
	// with a populated mergeCommit). A failure here does NOT undo the merge —
	// the merge already succeeded; the SHA is purely informational.
	let mergeSha = status.mergeSha;
	try {
		const after = await gh.prStatus(prNumber);
		if (after.mergeSha) mergeSha = after.mergeSha;
	} catch {
		/* best-effort — keep the pre-merge mergeSha (likely undefined) */
	}

	return { merged: true, finalState: "MERGED", mergeSha, localCi: ci, elapsedMs: elapsed() };
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
