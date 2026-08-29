/**
 * src/branch-cleanup.ts — the post-merge LOCAL branch cleanup.
 *
 * Why this exists (#2143/#2146 recurrence): `merge_pr_after_local_ci` merged
 * and deleted the REMOTE branch (REST `mergeNow` deletes the ref; gh's
 * `--delete-branch` handles it CLI-side), but nothing detached the merging
 * worktree off the head branch or deleted the LOCAL branch — git refuses
 * `branch -D` on a branch checked out in ANY worktree, so the caller had to
 * `checkout --detach <mergeSha>` + sweep by hand on every merge. The
 * merge-pr-after-ci CLI grew its own inline cleanup block for the same
 * reason; this module is the canonical, seam-injectable core both paths can
 * share (the CLI adoption is a follow-up — its behavior is already pinned by
 * tests).
 *
 * Semantics (mirrors the CLI block):
 *   1. A branch held by a DIFFERENT worktree is NOT ours to move — left in
 *      place, reported via `heldElsewhere` + a note.
 *   2. When THIS worktree sits on the head branch, detach onto `onto` (the
 *      caller guarantees `onto` resolves locally — fetch the merge sha
 *      first) so the delete below is not refused.
 *   3. Delete the local branch when it exists in this clone (a clone that
 *      never checked it out has nothing to delete — benign note, not an
 *      error).
 *   4. `fetch --prune` to refresh remote-tracking refs (the remote branch is
 *      gone by now).
 *
 * Everything is best-effort: a merge that already happened is NEVER failed by
 * cleanup — every failure lands in `notes` instead.
 */
import path from "node:path";
import type { BranchClient } from "./branch-recipe.js";

/** Structured outcome of the local branch cleanup (rendered by each caller). */
export interface BranchCleanupResult {
	headBranch: string;
	/** This worktree was ON the head branch and was detached onto `detachedOnto`. */
	detached: boolean;
	detachedOnto?: string;
	/** A detach was attempted and failed (delete likely refused as well). */
	detachFailed?: boolean;
	/** The local branch was deleted from this clone. */
	localDeleted: boolean;
	/** Another worktree holds the head branch — left in place (its path). */
	heldElsewhere?: string;
	/** No local branch of this name exists in this clone. */
	noLocalBranch?: boolean;
	/** Warnings / why-skipped notes — never fatal. */
	notes: string[];
}

/** The subset of BranchClient the cleanup needs (tests inject exactly this). */
export type BranchCleanupClient = Pick<
	BranchClient,
	"worktreeList" | "currentBranch" | "revParse" | "detachHead" | "deleteLocalBranch" | "fetchPrune"
>;

export interface BranchCleanupOptions {
	client: BranchCleanupClient;
	headBranch: string;
	repoRoot: string;
	/**
	 * A LOCAL ref to detach onto when this worktree sits on the head branch —
	 * normally the merge commit (the caller fetched it first; REST merges
	 * happen server-side and the sha is often absent from the local store).
	 * Omitted → no detach is attempted (the delete will then be refused with
	 * a note if this worktree is still on the branch).
	 */
	onto?: string;
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function runLocalBranchCleanup(opts: BranchCleanupOptions): Promise<BranchCleanupResult> {
	const { client, headBranch, repoRoot, onto } = opts;
	const res: BranchCleanupResult = { headBranch, detached: false, localDeleted: false, notes: [] };
	const mine = path.resolve(repoRoot);
	// 4. Refresh remote-tracking refs (the remote branch is gone by now) — run
	//    on EVERY path, including the held-elsewhere early return (the CLI
	//    prunes there too; a stale origin/<head> ref would linger otherwise).
	const bestEffortPrune = async (): Promise<void> => {
		try {
			await client.fetchPrune();
		} catch (err) {
			res.notes.push(`fetchPrune failed: ${errMsg(err)}`);
		}
	};

	// 1. Another worktree's checkout is not ours to move.
	let list: Array<{ worktree: string; branch?: string; detached?: boolean }> = [];
	try {
		list = await client.worktreeList();
	} catch (err) {
		res.notes.push(`worktreeList read failed: ${errMsg(err)}`);
	}
	const held = list.find((w) => w.branch === headBranch && path.resolve(w.worktree) !== mine)?.worktree;
	if (held) {
		res.heldElsewhere = held;
		res.notes.push(
			`local branch '${headBranch}' is checked out in another worktree (${held}) — left in place; delete it from there.`,
		);
		await bestEffortPrune();
		return res;
	}

	// 2. Detach THIS worktree off the head branch first — `branch -D` is
	//    refused on a branch checked out in ANY worktree, and ours is normally
	//    still sitting on it right after the merge.
	let current: string | undefined;
	try {
		current = await client.currentBranch();
	} catch (err) {
		res.notes.push(`currentBranch read failed: ${errMsg(err)}`);
	}
	if (current === headBranch) {
		if (onto) {
			try {
				await client.detachHead(onto);
				res.detached = true;
				res.detachedOnto = onto;
			} catch (err) {
				res.detachFailed = true;
				res.notes.push(`detachHead(${onto}) failed: ${errMsg(err)} — local branch delete will be skipped`);
			}
		} else {
			res.notes.push(
				`this worktree is on '${headBranch}' but no local detach target was available — local branch delete will be skipped`,
			);
		}
	}

	// 3. Delete the local branch when it exists in this clone.
	let exists = false;
	try {
		const sha = await client.revParse(headBranch);
		exists = typeof sha === "string" && sha.length > 0;
	} catch {
		exists = false;
	}
	if (!exists) {
		res.noLocalBranch = true;
		res.notes.push(`no local '${headBranch}' branch in this clone — nothing to delete`);
	} else {
		try {
			await client.deleteLocalBranch(headBranch);
			res.localDeleted = true;
		} catch (err) {
			res.notes.push(`deleteLocalBranch(${headBranch}) failed: ${errMsg(err)}`);
		}
	}

	await bestEffortPrune();
	return res;
}
