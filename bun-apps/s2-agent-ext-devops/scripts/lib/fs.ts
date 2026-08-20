/**
 * fs.ts — filesystem helpers for the s2-agent-sh deploy.
 *
 * freeze/unfreeze exist because a deployed tree is chmod a-w by default (a
 * deployed artifact must not be edited in place), and removal has to reopen
 * the tree first. Since Phase 3 the version dir's `s2-agent` is a HARDLINK
 * into <outRoot>/.cores/ — chmod-ing that file re-modes every version sharing
 * the inode — so unfreeze restores write bits on DIRECTORIES ONLY: unlinking
 * a file needs the parent dir's write bit, never the file's own.
 */
import { chmodSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Depth-first walk that never follows symlinks (chmod through a link would
 * escape the tree). Shared by the freeze/unfreeze helpers and the deploy-time
 * source rewrites (e.g. patchOfflinePackageLoadersUnder).
 */
export function walk(dir: string, fn: (p: string, isDir: boolean) => void): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		const p = join(dir, name);
		// Never follow symlinks — chmod through a link would escape the tree.
		const st = lstatSync(p);
		if (st.isSymbolicLink()) continue;
		if (st.isDirectory()) {
			walk(p, fn);
			fn(p, true);
		} else {
			fn(p, false);
		}
	}
}

/** Clear every write bit in the tree (files first, then dirs, then the root). */
export function freezeTree(root: string): void {
	walk(root, (p) => chmodSync(p, statSync(p).mode & ~0o222));
	chmodSync(root, statSync(root).mode & ~0o222);
}

/**
 * Restore the owner write bit on the tree's DIRECTORIES so it can be removed
 * or reorganised. Files stay a-w: nothing writes a frozen file in place (the
 * in-place `--ext` rebuild died with Phase 3), and a hardlinked core must
 * never be chmod-ed through one of its links.
 */
export function unfreezeTree(root: string): void {
	try {
		chmodSync(root, statSync(root).mode | 0o200);
	} catch {
		return;
	}
	walk(root, (p, isDir) => {
		if (isDir) chmodSync(p, statSync(p).mode | 0o200);
	});
}

/** Remove a tree, unfreezing first so a frozen deploy can be replaced. */
export function rmTree(root: string): void {
	unfreezeTree(root);
	rmSync(root, { recursive: true, force: true });
}
