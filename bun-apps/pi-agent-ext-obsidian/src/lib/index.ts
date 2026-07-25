import { join, resolve } from "node:path";
import { mkdir, readFile, stat } from "node:fs/promises";

import {
	atomicWriteFile,
	readCached,
	readBatched,
	listNotes,
} from "./fs-cache";
import { extractWikiLinks } from "./links";

// ---- Vault index (B1) ------------------------------------------------------
// Session-scoped derived index over the vault: title/tags/links adjacency,
// plus reverse maps (byTag, byTitle, reverseAdjacency) for O(1) graph queries.
// Built lazily on first use, incrementally updated on write (reindexFile).

export interface NoteMeta {
	path: string; // vault-relative, e.g. "Zettelkasten/Foo.md"
	title: string; // first H1 text, lowercased for lookup
	tags: string[]; // normalized, lowercased, no leading #
	links: string[]; // outgoing [[targets]], normalized (no .md, no alias/section)
	created?: string; // frontmatter created (YYYY-MM-DD)
	mtime: number; // last indexed mtime (ms)
	// Phase 6 / WS-C5: lowercase 3-grams of the note's full content, used to
	// pre-filter substring searches (trigram inverted index). A superset of all
	// searchable fields, so candidate filtering is always sound (never drops a
	// real hit) — only slightly loose across fields. Not persisted (C6 rebuilds
	// from content); hence omitted from serialization.
	trigrams: Set<string>;
}

export interface VaultIndex {
	vaultPath: string;
	notes: Map<string, NoteMeta>;
	byTag: Map<string, Set<string>>;
	byTitle: Map<string, string>; // lowercased title/path/basename -> path
	reverseAdjacency: Map<string, Set<string>>; // targetPath -> Set<sourcePath>
	// Phase 6 / WS-C5: trigram -> Set<notePath> inverted index for substring
	// search pre-filtering. Maintained incrementally by indexNote/unindexNote
	// (like byTag), so no rev/invalidation needed.
	trigrams: Map<string, Set<string>>;
	// Phase 3 / WS-C2: memoized undirected adjacency for graph queries.
	// Built lazily by getAdjacency(); invalidated by bumping `rev` on every
	// note mutation (indexNote/unindexNote). graphNeighbors rebuilds only when
	// adjacencyRev !== rev, instead of O(n) per call.
	rev: number; // mutation counter; bump on any notes change
	adjacency?: Map<string, Set<string>>; // undirected: path -> Set<neighborPath>
	adjacencyRev?: number; // rev the cache was built at
}

/** Compute the set of lowercase 3-grams of a string (Phase 6 / WS-C5).
 *  Used for substring-search candidate pre-filtering. Covers the FULL content
 *  (a superset of every searchable field) so trigram-based candidate sets are
 *  always a sound over-approximation — they never exclude a real hit. */
export function contentTrigrams(text: string): Set<string> {
	const s = new Set<string>();
	const lower = text.toLowerCase();
	for (let i = 0; i + 3 <= lower.length; i++) s.add(lower.slice(i, i + 3));
	return s;
}

/** Phase 6 / WS-C5 — narrow the substring-search candidate set via the trigram
 *  inverted index. Returns the set of note paths containing EVERY trigram of
 *  the query (a sound over-approximation: a file missing any query trigram
 *  cannot contain the query substring, so it is safely excluded). Returns null
 *  when filtering is not applicable (query shorter than 3 chars, or the index
 *  has no trigram map yet) — caller then falls back to scanning all files.
 *  Returns an empty set when some query trigram is absent from the vault. */
export function trigramCandidates(
	idx: VaultIndex | undefined,
	query: string,
): Set<string> | null {
	if (!idx || !idx.trigrams || query.length < 3) return null;
	const q = query.toLowerCase();
	let result: Set<string> | null = null;
	for (let i = 0; i + 3 <= q.length; i++) {
		const paths = idx.trigrams.get(q.slice(i, i + 3));
		if (!paths || paths.size === 0) return new Set(); // trigram absent → no hit possible
		if (!result) {
			result = new Set(paths);
		} else {
			for (const p of result) if (!paths.has(p)) result.delete(p);
		}
		if (result.size === 0) return result;
	}
	return result;
}

/** Parse a note into NoteMeta (no I/O). Reused by index build + reindex. */
export function parseNoteMeta(path: string, content: string, mtime: number): NoteMeta {
	const lines = content.split("\n");
	// title = first H1
	let title = "";
	for (const l of lines) {
		const m = l.match(/^#\s+(.+?)\s*$/);
		if (m) {
			title = m[1]!;
			break;
		}
	}
	// tags: frontmatter + inline
	const tags = new Set<string>();
	let inFm = false,
		fmDone = false;
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i]!;
		if (!fmDone && i === 0 && l.trim() === "---") {
			inFm = true;
			continue;
		}
		if (inFm && l.trim() === "---") {
			inFm = false;
			fmDone = true;
			continue;
		}
		if (inFm && /^\s*tags?\s*:/.test(l)) {
			const arr = l.replace(/^\s*tags?\s*:\s*/, "");
			for (const raw of arr.split(",")) {
				const t = raw
					.replace(/[[\]"']/g, "")
					.trim()
					.toLowerCase();
				if (t) tags.add(t);
			}
		} else if (!inFm) {
			const re = /(^|\s)#([A-Za-z0-9_-]+)/g;
			let mm;
			while ((mm = re.exec(l))) tags.add(mm[2]!.toLowerCase());
		}
	}
	// created
	let created: string | undefined;
	const cm = content.match(
		/^---\n[\s\S]*?^created:\s*["']?(\d{4}-\d{2}-\d{2})/m,
	);
	if (cm) created = cm[1]!;
	// links
	const links = new Set<string>();
	for (const l of lines)
		for (const link of extractWikiLinks(l)) {
			links.add(link.replace(/\.md$/i, ""));
		}
	return {
		path,
		title: title.toLowerCase(),
		tags: [...tags],
		links: [...links],
		created,
		mtime,
		trigrams: contentTrigrams(content),
	};
}

export const indexCache = new Map<string, VaultIndex>();
// Phase 3 / WS-C4: in-flight index builds, so concurrent getIndex() calls on
// the same (uncached) vault share ONE buildIndex instead of racing parallel
// full-vault scans. Resolved + cleared once the build settles into indexCache.
export const indexInFlight = new Map<string, Promise<VaultIndex>>();

// ---- Index coherence (Phase 4: WS-A5 + WS-C3) -----------------------------
// The file cache (readCached) is already mtime-coherent per read. The INDEX,
// however, is built once and cached — so external edits (e.g. a note changed in
// the Obsidian app mid-session) left byTag / byTitle / reverseAdjacency stale
// until a manual obsidian_invalidate. refreshIndex() fixes that incrementally:
// it re-enumerates the vault (readdir + stat only — no content read) and
// reindexes just the files whose mtime changed, plus picks up adds/deletes.
// Throttled so a burst of tool calls within one turn doesn't re-scan repeatedly.
// Poll window is read live from env so it can be tuned at runtime (and set to 0
// in tests to disable throttling without waiting).
export const INDEX_POLL_MS_DEFAULT = 2000;
export const indexPollMs = () => Number(process.env.OB_INDEX_POLL_MS ?? INDEX_POLL_MS_DEFAULT);
export const indexRefreshAt = new Map<string, number>(); // vault real path -> ms of last refresh

/** Get or lazily build the index for a vault. On a cache hit, opportunistically
 *  refresh incrementally (throttled) so external edits are picked up without a
 *  manual invalidate. */
export async function getIndex(vaultPath: string): Promise<VaultIndex> {
	const real = resolve(vaultPath);
	let idx = indexCache.get(real);
	if (idx) {
		await refreshIndex(idx, { force: false });
		return idx;
	}
	// Phase 3 / WS-C4: single-flight — if another caller is already building
	// this vault's index, await its promise rather than starting a parallel scan.
	let inflight = indexInFlight.get(real);
	if (!inflight) {
		inflight = (async () => {
			try {
				// Phase 6 / WS-C6: try a persisted index first (stat-validated);
				// only fall back to a full O(n) buildIndex if there's no cache.
				let built = await loadCachedIndex(real);
				if (!built) built = await buildIndex(real);
				indexCache.set(real, built);
				indexRefreshAt.set(real, Date.now());
				// persist for next session (best-effort, non-blocking)
				void saveIndex(built).catch(() => {});
				return built;
			} finally {
				indexInFlight.delete(real);
			}
		})();
		indexInFlight.set(real, inflight);
	}
	return inflight;
}

/** Build a fresh index over the whole vault. O(n). */
export async function buildIndex(vaultPath: string): Promise<VaultIndex> {
	const real = resolve(vaultPath);
	const files = await listNotes(real, "");
	const paths = files.map((f) => join(real, f));
	const entries = await readBatched(paths);
	const idx: VaultIndex = {
		vaultPath: real,
		notes: new Map(),
		byTag: new Map(),
		byTitle: new Map(),
		reverseAdjacency: new Map(),
		trigrams: new Map(),
		rev: 0,
	};
	for (let i = 0; i < files.length; i++) {
		const entry = entries[i];
		if (!entry) continue;
		const meta = parseNoteMeta(files[i]!, entry.content, entry.mtime);
		indexNote(idx, meta);
	}
	// Second pass: now that all notes are in byTitle, recompute link resolution
	// so reverseAdjacency keys are actual note paths (a link added before its
	// target was indexed would otherwise key on the raw lowercased target).
	rebuildReverseAdjacency(idx);
	return idx;
}

/** Second pass: recompute reverseAdjacency so its keys are actual note paths
 *  (a link parsed before its target was indexed keys on the raw target). Shared
 *  by buildIndex and loadCachedIndex. */
export function rebuildReverseAdjacency(idx: VaultIndex): void {
	idx.reverseAdjacency.clear();
	for (const meta of idx.notes.values()) {
		for (const link of meta.links) {
			const resolved = resolveLink(idx, link) ?? link.toLowerCase();
			let s = idx.reverseAdjacency.get(resolved);
			if (!s) {
				s = new Set();
				idx.reverseAdjacency.set(resolved, s);
			}
			s.add(meta.path);
		}
	}
}

// ---- Cross-session index persistence (Phase 6 / WS-C6) --------------------
// The index is a module-level Map cleared on exit, so every fresh session paid
// a full O(n) buildIndex (read every file's content + parse). This persists the
// index to <vault>/.cache/pi-obsidian-index.json and, on a cold getIndex, loads
// it + stat-validates each note: notes unchanged since last session reuse their
// persisted meta (incl. trigrams — no content re-read), only changed/new notes
// are re-read. Disable with OB_INDEX_PERSIST=0; relocate the file with
// OB_INDEX_CACHE_DIR. Best-effort — any read/parse/write failure silently falls
// back to a full buildIndex.
export const INDEX_CACHE_VERSION = 1;
export function indexCachePath(vaultReal: string): string {
	const dir = process.env.OB_INDEX_CACHE_DIR || join(vaultReal, ".cache");
	return join(dir, "pi-obsidian-index.json");
}

/** Parallel stat → mtimeMs (null for absent). */
export async function statMtimes(absPaths: string[]): Promise<(number | null)[]> {
	return Promise.all(
		absPaths.map((p) =>
			stat(p)
				.then((s) => s.mtimeMs)
				.catch(() => null),
		),
	);
}

/** Serialize the index to a plain JSON-safe object. Persisted notes carry their
 *  trigrams so a warm reload needs NO content re-read (keeps C5 trigram search
 *  working across sessions). Derived maps (byTag/byTitle/reverseAdjacency/
 *  trigrams-inverted) are rebuilt on load, not stored. */
export function serializeIndex(idx: VaultIndex): {
	version: number;
	vaultPath: string;
	rev: number;
	notes: any[];
} {
	return {
		version: INDEX_CACHE_VERSION,
		vaultPath: idx.vaultPath,
		rev: idx.rev,
		notes: [...idx.notes.values()].map((n) => ({
			path: n.path,
			title: n.title,
			tags: n.tags,
			links: n.links,
			created: n.created,
			mtime: n.mtime,
			trigrams: [...n.trigrams],
		})),
	};
}

/** Write the index to disk (best-effort, never throws). */
export async function saveIndex(idx: VaultIndex): Promise<void> {
	if (process.env.OB_INDEX_PERSIST === "0") return;
	try {
		const path = indexCachePath(idx.vaultPath);
		await mkdir(join(path, ".."), { recursive: true });
		await atomicWriteFile(path, JSON.stringify(serializeIndex(idx)));
	} catch {
		// best-effort: a failed save just means a full rebuild next session
	}
}

/** Load + mtime-validate a persisted index. Returns null when there is no
 *  cache, it's the wrong version, or anything goes wrong (caller falls back to
 *  buildIndex). Notes unchanged on disk reuse their persisted meta (incl.
 *  trigrams); changed/new notes are re-read and re-parsed. */
export async function loadCachedIndex(
	vaultReal: string,
): Promise<VaultIndex | null> {
	if (process.env.OB_INDEX_PERSIST === "0") return null;
	let raw: string;
	try {
		raw = await readFile(indexCachePath(vaultReal), "utf8");
	} catch {
		return null;
	}
	let data: any;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!data || data.version !== INDEX_CACHE_VERSION || !Array.isArray(data.notes))
		return null;

	const files = await listNotes(vaultReal, "");
	const persisted = new Map<string, any>(data.notes.map((n: any) => [n.path, n]));
	const mtimes = await statMtimes(files.map((f) => join(vaultReal, f)));

	const idx: VaultIndex = {
		vaultPath: vaultReal,
		notes: new Map(),
		byTag: new Map(),
		byTitle: new Map(),
		reverseAdjacency: new Map(),
		trigrams: new Map(),
		rev: 0,
	};
	const stale: string[] = [];
	for (let i = 0; i < files.length; i++) {
		const f = files[i];
		if (!f) continue;
		const mtime = mtimes[i];
		const p = persisted.get(f);
		if (mtime !== null && p && p.mtime === mtime) {
			// unchanged since last session — reuse persisted meta (trigrams incl.)
			indexNote(idx, {
				path: p.path,
				title: p.title,
				tags: Array.isArray(p.tags) ? p.tags : [],
				links: Array.isArray(p.links) ? p.links : [],
				created: p.created,
				mtime: p.mtime,
				trigrams: new Set(Array.isArray(p.trigrams) ? p.trigrams : []),
			});
		} else {
			// changed or new — must re-read content
			stale.push(f);
		}
	}
	if (stale.length > 0) {
		const entries = await readBatched(stale.map((f) => join(vaultReal, f)));
		for (let i = 0; i < stale.length; i++) {
			const entry = entries[i];
			if (!entry) continue;
			indexNote(idx, parseNoteMeta(stale[i]!, entry.content, entry.mtime));
		}
	}
	rebuildReverseAdjacency(idx);
	return idx;
}

/** Keys under which a note should be discoverable in byTitle: its lowercased
 *  title (H1) AND its lowercased path-without-extension AND bare basename.
 *  This lets `[[Name]]`, `[[folder/Name]]`, and title-based links all resolve. */
export function titleKeysFor(meta: NoteMeta): string[] {
	const keys = new Set<string>();
	if (meta.title) keys.add(meta.title);
	const noExt = meta.path.replace(/\.md$/i, "").toLowerCase();
	keys.add(noExt);
	keys.add(noExt.split("/").pop() ?? noExt);
	return [...keys];
}

/** Insert/update a single note's meta in the index. */
export function indexNote(idx: VaultIndex, meta: NoteMeta): void {
	// remove any prior entry for this path (incremental reindex)
	unindexNote(idx, meta.path);
	idx.notes.set(meta.path, meta);
	for (const k of titleKeysFor(meta)) idx.byTitle.set(k, meta.path);
	for (const t of meta.tags) {
		let s = idx.byTag.get(t);
		if (!s) {
			s = new Set();
			idx.byTag.set(t, s);
		}
		s.add(meta.path);
	}
	for (const link of meta.links) {
		const resolved = resolveLink(idx, link) ?? link.toLowerCase();
		let s = idx.reverseAdjacency.get(resolved);
		if (!s) {
			s = new Set();
			idx.reverseAdjacency.set(resolved, s);
		}
		s.add(meta.path);
	}
	// Phase 6 / WS-C5: trigram inverted index.
	for (const tg of meta.trigrams) {
		let s = idx.trigrams.get(tg);
		if (!s) {
			s = new Set();
			idx.trigrams.set(tg, s);
		}
		s.add(meta.path);
	}
	idx.rev++; // Phase 3 / WS-C2: invalidate memoized adjacency
}

/** Remove a note from all index maps. */
export function unindexNote(idx: VaultIndex, path: string): void {
	const old = idx.notes.get(path);
	if (!old) return;
	idx.rev++; // Phase 3 / WS-C2: invalidate memoized adjacency
	idx.notes.delete(path);
	for (const k of titleKeysFor(old))
		if (idx.byTitle.get(k) === path) idx.byTitle.delete(k);
	for (const t of old.tags) {
		const s = idx.byTag.get(t);
		if (s) {
			s.delete(path);
			if (s.size === 0) idx.byTag.delete(t);
		}
	}
	for (const link of old.links) {
		const resolved = resolveLink(idx, link) ?? link.toLowerCase();
		const s = idx.reverseAdjacency.get(resolved);
		if (s) {
			s.delete(path);
			if (s.size === 0) idx.reverseAdjacency.delete(resolved);
		}
	}
	// Phase 6 / WS-C5: remove from trigram inverted index.
	for (const tg of old.trigrams) {
		const s = idx.trigrams.get(tg);
		if (s) {
			s.delete(path);
			if (s.size === 0) idx.trigrams.delete(tg);
		}
	}
}

/** Resolve a wiki-link target to an actual note path via byTitle (exact, then basename). */
export function resolveLink(idx: VaultIndex, target: string): string | undefined {
	const t = target.replace(/\.md$/i, "").toLowerCase();
	if (idx.byTitle.has(t)) return idx.byTitle.get(t)!;
	const base = t.split("/").pop() ?? t;
	if (idx.byTitle.has(base)) return idx.byTitle.get(base)!;
	return undefined;
}

/** Reindex a single file (called after writes). Reads through the cache. */
export async function reindexFile(
	vaultPath: string,
	notePath: string,
): Promise<void> {
	const real = resolve(vaultPath);
	const idx = indexCache.get(real);
	if (!idx) return; // not yet built; lazy build will pick it up
	const abs = join(real, notePath);
	const entry = await readCached(abs);
	if (!entry) {
		unindexNote(idx, notePath);
		return;
	}
	indexNote(idx, parseNoteMeta(notePath, entry.content, entry.mtime));
}

/** Drop the index for a vault (forces rebuild on next getIndex). */
export function dropIndex(vaultPath: string): void {
	indexCache.delete(resolve(vaultPath));
}

/** Incrementally reconcile the index with the current on-disk vault state.
 *  Readdir + stat every file (cheap — no content read), then reindex only the
 *  changed/added files and drop the deleted ones. Returns a small diff summary
 *  so callers (obsidian_invalidate, tests) can report what changed.
 *
 *  Throttled by INDEX_POLL_MS unless `force` is true (used by the explicit
 *  obsidian_invalidate tool and write paths, which want immediate effect). */
export async function refreshIndex(
	idx: VaultIndex,
	opts: { force?: boolean } = {},
): Promise<{ added: number; changed: number; deleted: number }> {
	const real = idx.vaultPath;
	const now = Date.now();
	if (!opts.force && now - (indexRefreshAt.get(real) ?? 0) < indexPollMs()) {
		return { added: 0, changed: 0, deleted: 0 };
	}
	indexRefreshAt.set(real, now);

	const files = await listNotes(real, "");
	const seen = new Set<string>();
	const toReindex: string[] = [];
	let added = 0;
	let changed = 0;
	for (const f of files) {
		seen.add(f);
		const abs = join(real, f);
		let st;
		try {
			st = await stat(abs);
		} catch {
			continue; // vanished between readdir and stat; next refresh retries
		}
		const prev = idx.notes.get(f);
		if (!prev) added++;
		else if (prev.mtime !== st.mtimeMs) changed++;
		else continue;
		toReindex.push(f);
	}
	// Deleted externally: indexed paths no longer present on disk.
	const deleted: string[] = [];
	for (const p of idx.notes.keys()) if (!seen.has(p)) deleted.push(p);

	for (const f of toReindex) {
		const entry = await readCached(join(real, f));
		if (entry) indexNote(idx, parseNoteMeta(f, entry.content, entry.mtime));
		// (if readCached returned null — race: file gone — unindex below via deleted)
	}
	for (const f of deleted) unindexNote(idx, f);

	return { added, changed, deleted: deleted.length };
}
