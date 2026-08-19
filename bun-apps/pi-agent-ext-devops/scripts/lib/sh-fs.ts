/**
 * sh-fs.ts — filesystem helpers for the pi-agent-sh deploy.
 *
 * freeze/unfreeze exist because a deployed tree is chmod a-w by default (a
 * deployed artifact must not be edited in place), and the single-extension
 * rebuild path has to temporarily reopen exactly one subtree.
 */
import { chmodSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, fn: (p: string, isDir: boolean) => void): void {
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

/** Restore the owner write bit so the tree can be modified or removed. */
export function unfreezeTree(root: string): void {
	try {
		chmodSync(root, statSync(root).mode | 0o200);
	} catch {
		return;
	}
	walk(root, (p) => chmodSync(p, statSync(p).mode | 0o200));
}

/** Remove a tree, unfreezing first so a frozen deploy can be replaced. */
export function rmTree(root: string): void {
	unfreezeTree(root);
	rmSync(root, { recursive: true, force: true });
}
