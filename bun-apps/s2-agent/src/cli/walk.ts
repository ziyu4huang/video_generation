/**
 * walk.ts — the recursive directory walk shared by the CLI commands that scan
 * a tree for files: zk-extract's input expansion (collect *.md/*.txt) and
 * pdf-to-vault's PNG cleanup (delete *.png). The per-file filter + action stay
 * at each call site; only the readdir/stat/recurse skeleton is shared.
 *
 * Semantics: deterministic readdir order, statSync per entry (symlinks are
 * followed, matching both callers' prior inline walks), directories recursed,
 * and only regular files surfaced. The transcript walk in sessions/discover.ts
 * is deliberately NOT routed here — it filters by mtime/session shape.
 */
import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** Invoke `onFile(full, entry)` for every regular file under `dir`, recursively. */
export function walkFiles(
	dir: string,
	onFile: (full: string, entry: string) => void,
): void {
	for (const entry of readdirSync(dir)) {
		const full = resolve(dir, entry);
		const s = statSync(full);
		if (s.isDirectory()) walkFiles(full, onFile);
		else if (s.isFile()) onFile(full, entry);
	}
}
