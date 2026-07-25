import {
	readFile,
	writeFile,
	readdir,
	rm,
	stat,
	rename as fsRename,
	unlink as fsUnlink,
	cp as fsCp,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import {
	VaultError,
	classifyFsError,
	fsErrCode,
	errMsg,
} from "./errors";

/** Atomic write: write to `<path>.<pid>.tmp` then rename. Prevents partial
 *  writes from being observed by the Obsidian app or a concurrent search if
 *  the process is killed mid-write (A2.1). Temp file is cleaned up on failure. */
export async function atomicWriteFile(
	absPath: string,
	data: string,
): Promise<void> {
	const tmp = `${absPath}.${process.pid}.tmp`;
	try {
		await writeFile(tmp, data, "utf8");
		await renameOverwrite(tmp, absPath);
	} catch (e) {
		await rm(tmp, { force: true }).catch(() => {});
		throw e;
	}
}

type FsDouble = {
	rename?: (from: string, to: string) => Promise<void>;
	unlink?: (p: string) => Promise<void>;
	rm?: (p: string, opts?: { force?: boolean }) => Promise<void>;
	cp?: (src: string, dst: string, opts?: { force?: boolean }) => Promise<void>;
};

/** rename with fallbacks: EXDEV → copy+delete; win32 EPERM/EEXIST → unlink+retry.
 *  The optional `fs` double is a testability seam (defaults to real node fs) —
 *  production callers pass no options and get unchanged behavior. */
export const renameOverwrite = async (
	from: string,
	to: string,
	fs: FsDouble = {},
): Promise<void> => {
	const rename = fs.rename ?? fsRename;
	const unlink = fs.unlink ?? fsUnlink;
	const cp = fs.cp ?? fsCp;
	try {
		await rename(from, to);
	} catch (e: any) {
		const code = e?.code;
		if (code === "EXDEV") {
			// cross-device: copy then delete source (unchanged behavior). Use
			// rm({force}) — NOT unlink — so a vanished source between cp and
			// cleanup is absorbed idempotently (atomicWriteFile, moveNote).
			await cp(from, to, { force: true });
			const rmFn = fs.rm ?? rm;
			await rmFn(from, { force: true });
			return;
		}
		if (code === "EPERM" || code === "EEXIST") {
			// win32: rename onto an existing target throws; remove it and retry once.
			await unlink(to);
			await rename(from, to);
			return;
		}
		throw e;
	}
};

/** Stat a note; return its mtime (ms) or undefined if absent. Throws VaultError
 *  on non-ENOENT FS errors (WS-A1: don't conflate EACCES with "absent"). */
export async function noteMtime(absPath: string): Promise<number | undefined> {
	try {
		return (await stat(absPath)).mtimeMs;
	} catch (e) {
		if (fsErrCode(e) === "ENOENT") return undefined;
		throw new VaultError(classifyFsError(e), errMsg(e));
	}
}

/** Optimistic-concurrency guard (WS-A4). expectedMtime only constrains the
 *  existing-file case: when the file is absent the caller proceeds (append /
 *  create may create-new); update_frontmatter treats absent as NOT_FOUND
 *  upstream. Returns a VaultError(CONFLICT) to throw, or null. */
export function mtimeConflict(
	note: string,
	expected: number | undefined,
	actual: number | undefined,
): VaultError | null {
	if (expected === undefined || actual === undefined) return null;
	if (expected !== actual)
		return new VaultError(
			"CONFLICT",
			`Conflict: ${note} was modified (expected mtime ${expected}, actual ${actual}).`,
		);
	return null;
}


// ---- Session-scoped read cache (Phase 3) ----------------------------------
// Caches file content + derived structures keyed by absolute path, invalidated
// by mtime or explicitly via invalidateCache(). Write tools call invalidateCache
// for the path they touched so a subsequent search reflects the change at once.
export interface CacheEntry {
	mtime: number;
	content: string;
	lines: string[];
}
export const fileCache = new Map<string, CacheEntry>();
/** Soft cap on the file cache. Read live from OB_CACHE_MAX so it is tunable at
 *  runtime (operator hot-reload of a small/large working set) and so tests can
 *  exercise eviction without re-loading the module. Defaults to 500. */
export function fileCacheMax(): number {
	return Number(process.env.OB_CACHE_MAX ?? 500);
}

/** Read a file through the cache. Re-reads only when mtime changed. */
export async function readCached(absPath: string): Promise<CacheEntry | null> {
	let stat;
	try {
		stat = await (await import("node:fs/promises")).stat(absPath);
	} catch (e) {
		// Absent/vanished (ENOENT) is an expected cache miss → drop & return null.
		// Other errors (EACCES/EIO/ENOTDIR) are ALSO absorbed here on purpose:
		// readCached is a best-effort hot path feeding batch search & index, and
		// must NEVER crash a whole search because ONE file is unreadable. The
		// user-facing tools read their single target file DIRECTLY (not through
		// this cache) and surface a structured PERMISSION_DENIED / IO_ERROR there.
		fileCache.delete(absPath);
		return null;
	}
	const mtime = stat.mtimeMs;
	const cached = fileCache.get(absPath);
	if (cached && cached.mtime === mtime) {
		// A8: access-order LRU. Map iterates in insertion order; a plain hit
		// returns without moving the entry, so a hot MOC/index note read
		// repeatedly gets evicted the moment the cap fills, identical to a
		// one-shot read. Re-inserting on a hit promotes it to the tail, so the
		// head-eviction below drops the genuinely least-recently-used entry.
		fileCache.delete(absPath);
		fileCache.set(absPath, cached);
		return cached;
	}
	let content: string;
	try {
		content = await readFile(absPath, "utf8");
	} catch (e) {
		// Same best-effort contract as the stat catch above (see WS-A1 note).
		fileCache.delete(absPath);
		return null;
	}
	const entry: CacheEntry = { mtime, content, lines: content.split("\n") };
	// A8: delete-then-set so an mtime-stale re-read (existing key) is also
	// promoted to the tail — `set` on an existing key would update the value
	// but leave it at its old position, breaking access-order.
	fileCache.delete(absPath);
	fileCache.set(absPath, entry);
	// A8: LRU cap — evict least-recently-used entries (map head) until at/below
	// the limit. `while` (not `if`) so shrinking OB_CACHE_MAX mid-session, or a
	// batch insert, can never leave the cache over cap. Combined with the
	// re-insert-on-hit / delete-then-set above, this is true access-order LRU.
	while (fileCache.size > fileCacheMax()) {
		const oldest = fileCache.keys().next().value;
		if (oldest === undefined) break;
		fileCache.delete(oldest);
	}
	return entry;
}

/** Invalidate a single path (pass the vault-relative note path) or the whole cache.
 *  Safe to call with a path that was never cached. */
export function invalidateCache(absPath?: string): void {
	if (absPath) fileCache.delete(absPath);
	else fileCache.clear();
}

/** @internal Test-only: ordered snapshot of cached paths (LRU head → tail).
 *  Lets eviction order be asserted without exposing the live Map. */
export function __fileCacheOrder(): string[] {
	return [...fileCache.keys()];
}

/** Read up to `concurrency` files in parallel via readCached. Returns entries
 *  in the SAME order as the input paths (null for unreadable). */
export async function readBatched(
	paths: string[],
	concurrency = 32,
): Promise<(CacheEntry | null)[]> {
	const out: (CacheEntry | null)[] = new Array(paths.length);
	let idx = 0;
	async function worker() {
		while (idx < paths.length) {
			const i = idx++;
			const p = paths[i];
			if (!p) continue;
			out[i] = await readCached(p);
		}
	}
	const n = Math.min(concurrency, paths.length);
	await Promise.all(Array.from({ length: n }, () => worker()));
	return out;
}

/** Recursively list .md files under a folder, relative to the vault root. */
export async function listNotes(vaultPath: string, folder: string): Promise<string[]> {
	const root = resolve(vaultPath, folder);
	const out: string[] = [];
	async function walk(dir: string) {
		let entries: import("node:fs").Dirent<string>[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (e) {
			// Unreadable subfolder (EACCES/ENOTDIR/vanished race) → skip it and
			// keep walking the rest. Best-effort enumeration, like readCached.
			return;
		}
		for (const e of entries) {
			if (e.name === ".obsidian" || e.name.startsWith(".")) continue;
			const full = join(dir, e.name);
			if (e.isDirectory()) await walk(full);
			else if (e.isFile() && e.name.endsWith(".md")) {
				out.push(full.slice(vaultPath.length).replace(/^[/\\]+/, ""));
			}
		}
	}
	await walk(root);
	return out.sort();
}

/** Count markdown notes in a vault (best-effort: 0 on any FS error). */
export async function countNotes(vaultPath: string): Promise<number> {
	try {
		return (await listNotes(vaultPath, "")).length;
	} catch {
		return 0;
	}
}
