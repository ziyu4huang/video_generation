import { join } from "node:path";

import { type VaultIndex, getIndex, resolveLink } from "./index";
import { listNotes, readBatched } from "./fs-cache";
import { parseFrontmatter } from "./frontmatter";
import { extractWikiLinks } from "./links";

/** Resolve a wiki-link target to a note path (exported for tests/B3). */
export function resolveWikiLink(
	idx: VaultIndex,
	target: string,
): string | undefined {
	return resolveLink(idx, target);
}

/** O(1) backlink path set via index.reverseAdjacency (B1.2). */
export function backlinkPaths(idx: VaultIndex, target: string): Set<string> {
	const t = target.replace(/\.md$/i, "").toLowerCase();
	const resolved =
		idx.byTitle.get(t) ?? idx.byTitle.get(t.split("/").pop() ?? t) ?? t;
	return idx.reverseAdjacency.get(resolved) ?? new Set();
}

/** O(1) tag path set via index.byTag (B1.2). */
export function tagPaths(idx: VaultIndex, tag: string): Set<string> {
	return idx.byTag.get(tag.replace(/^#/, "").toLowerCase()) ?? new Set();
}

// ---- Graph queries (B2) ----------------------------------------------------

export type GraphMode =
	| "backlinks"
	| "outgoing"
	| "orphans"
	| "dead-links"
	| "neighbors";

export interface GraphResult {
	path: string;
	line?: number; // 0 when not applicable
	text: string; // title or the offending link line
	depth?: number; // only for neighbors
}

/** Outgoing links of a note (B2.1). */
export function graphOutgoing(idx: VaultIndex, note: string): GraphResult[] {
	const path =
		idx.byTitle.get(note.toLowerCase()) ??
		idx.byTitle.get(note.toLowerCase().split("/").pop() ?? note);
	if (!path) return [];
	const meta = idx.notes.get(path);
	if (!meta) return [];
	const out: GraphResult[] = [];
	for (const link of meta.links) {
		const resolved = resolveLink(idx, link);
		out.push({
			path: resolved ?? link,
			text: `[[${link}]]${resolved ? "" : " (unresolved)"}`,
		});
	}
	return out;
}

/** Orphan notes: no inbound links (B2.2). An orphan is a note that no
 *  other note links TO — i.e. it never appears as a resolved target in
 *  reverseAdjacency (whose KEYS are link targets). */
export function graphOrphans(idx: VaultIndex): GraphResult[] {
	const linkedTargets = new Set<string>();
	for (const target of idx.reverseAdjacency.keys()) linkedTargets.add(target);
	return [...idx.notes.values()]
		.filter((m) => !linkedTargets.has(m.path))
		.map((m) => ({ path: m.path, text: m.title || m.path }));
}

/** Dead links: [[Target]] whose target is not in byTitle (B2.3).
 *  Requires re-reading source files for line numbers; falls back to no-line. */
export function graphDeadLinks(idx: VaultIndex): GraphResult[] {
	const out: GraphResult[] = [];
	for (const meta of idx.notes.values()) {
		for (const link of meta.links) {
			if (!resolveLink(idx, link)) {
				out.push({ path: meta.path, text: `[[${link}]]` });
			}
		}
	}
	return out;
}

/** Build the undirected adjacency map (path -> Set<neighborPath>) from notes'
 *  resolved links. Phase 3 / WS-C2: memoized on the index via getAdjacency()
 *  so repeated graphNeighbors calls don't rebuild it O(n) each time. */
export function buildAdjacency(idx: VaultIndex): Map<string, Set<string>> {
	const adj = new Map<string, Set<string>>();
	const addEdge = (a: string, b: string) => {
		if (!adj.has(a)) adj.set(a, new Set());
		if (!adj.has(b)) adj.set(b, new Set());
		adj.get(a)!.add(b);
		adj.get(b)!.add(a);
	};
	for (const meta of idx.notes.values()) {
		for (const link of meta.links) {
			const resolved = resolveLink(idx, link) ?? link;
			addEdge(meta.path, resolved);
		}
	}
	return adj;
}

/** Return the memoized undirected adjacency, rebuilding only when notes changed
 *  since the last build (tracked by idx.rev). Phase 3 / WS-C2. */
export function getAdjacency(idx: VaultIndex): Map<string, Set<string>> {
	if (idx.adjacency && idx.adjacencyRev === idx.rev) return idx.adjacency;
	const adj = buildAdjacency(idx);
	idx.adjacency = adj;
	idx.adjacencyRev = idx.rev;
	return adj;
}

/** N-hop neighborhood via BFS over undirected adjacency (B2.4).
 *  Phase 3 / WS-C2: uses the memoized adjacency (getAdjacency) instead of
 *  rebuilding the full edge set on every call. */
export function graphNeighbors(
	idx: VaultIndex,
	note: string,
	maxDepth = 1,
	max = 50,
): GraphResult[] {
	const startKey = note.toLowerCase();
	const startPath =
		idx.byTitle.get(startKey) ??
		idx.byTitle.get(startKey.split("/").pop() ?? startKey);
	if (!startPath) return [];
	const adj = getAdjacency(idx);
	const results: GraphResult[] = [];
	const visited = new Set<string>([startPath]);
	let frontier = [startPath];
	for (let d = 1; d <= maxDepth && frontier.length; d++) {
		const next: string[] = [];
		for (const node of frontier) {
			for (const nb of adj.get(node) ?? []) {
				if (!visited.has(nb)) {
					visited.add(nb);
					next.push(nb);
					results.push({
						path: nb,
						depth: d,
						text: idx.notes.get(nb)?.title || nb,
					});
					if (results.length >= max) return results;
				}
			}
		}
		frontier = next;
	}
	return results;
}

/** Structured metadata query (B4.1/B4.2). Index-only, no body reads.
 *  - tags:    AND semantics (note must carry ALL listed tags)
 *  - anyTags: OR semantics (note carries ANY of these)
 *  - folder:  restrict to a sub-tree
 *  - createdAfter / createdBefore: filter by frontmatter `created` (YYYY-MM-DD)
 *  Returns note metadata (path, title, tags, created). */
export async function queryNotes(
	vaultPath: string,
	opts: {
		tags?: string[];
		anyTags?: string[];
		folder?: string;
		createdAfter?: string;
		createdBefore?: string;
		max?: number;
	} = {},
): Promise<
	{ path: string; title: string; tags: string[]; created?: string }[]
> {
	const idx = await getIndex(vaultPath);
	let candidates = [...idx.notes.values()];
	const folder = opts.folder?.replace(/^[/\\]+/, "");
	if (folder)
		candidates = candidates.filter((m) => m.path.startsWith(folder + "/"));
	if (opts.tags && opts.tags.length) {
		const want = opts.tags.map((t) => t.replace(/^#/, "").toLowerCase());
		candidates = candidates.filter((m) =>
			want.every((t) => m.tags.includes(t)),
		);
	}
	if (opts.anyTags && opts.anyTags.length) {
		const want = new Set(
			opts.anyTags.map((t) => t.replace(/^#/, "").toLowerCase()),
		);
		candidates = candidates.filter((m) => m.tags.some((t) => want.has(t)));
	}
	if (opts.createdAfter)
		candidates = candidates.filter(
			(m) => (m.created ?? "") >= opts.createdAfter!,
		);
	if (opts.createdBefore)
		candidates = candidates.filter(
			(m) => (m.created ?? "") <= opts.createdBefore!,
		);
	const max = opts.max ?? 200;
	return candidates.slice(0, max).map((m) => ({
		path: m.path,
		title: m.title,
		tags: m.tags,
		created: m.created,
	}));
}

/** Detect Zettel titles that deviate from the dominant separator style (C3.4).
 *  Classifies each title by its top-level separator: 'em' (—), 'colon' (:),
 *  'dash' (-), or 'plain'. Returns titles whose style is not the vault's mode. */
export function detectTitleStyleOutliers(
	idx: VaultIndex,
): { path: string; title: string; style: string }[] {
	const styleOf = (title: string): string => {
		if (title.includes("\u2014")) return "em"; // —
		if (/^[^:]+:/.test(title)) return "colon";
		if (title.includes(" - ")) return "dash";
		return "plain";
	};
	const counts: Record<string, number> = {};
	const metas = [...idx.notes.values()];
	// Compute each title's style once and reuse it for the count, filter, and
	// map passes (styleOf runs regexes, so this avoids 3× work per outlier).
	const tagged = metas.map((m) => ({ m, s: styleOf(m.title) }));
	for (const { s } of tagged) counts[s] = (counts[s] ?? 0) + 1;
	let mode = "plain";
	let max = 0;
	for (const [s, c] of Object.entries(counts))
		if (c > max) {
			max = c;
			mode = s;
		}
	return tagged
		.filter((t) => t.s !== mode)
		.map((t) => ({ path: t.m.path, title: t.m.title, style: t.s }));
}

/** Find notes that wiki-link to `target` (a note title/path). Returns matches
 *  like searchVault: {file, line, text}. `target` may include `.md`; it is
 *  normalized away. Matching is case-insensitive unless `caseSensitive`.
 *
 *  Obsidian allows both bare `[[name]]` and path-qualified `[[folder/name]]`
 *  wikilinks to refer to the same note. This function matches a link when:
 *  - the full link path equals `target` (exact), OR
 *  - the basename of the link equals the basename of `target`
 *  so that searching for backlinks to "z001" also finds `[[Zettelkasten/z001]]`. */
export async function findBacklinks(
	vaultPath: string,
	target: string,
	opts: { folder?: string; caseSensitive?: boolean; max: number },
): Promise<{ file: string; line: number; text: string }[]> {
	const want = target.replace(/\.md$/i, "").trim();
	const cmp = (s: string) => (opts.caseSensitive ? s : s.toLowerCase());
	const wantN = cmp(want);
	// Pre-compute basename of target for path-qualified link matching.
	const wantBase = cmp(want.split("/").pop() ?? want);
	const results: { file: string; line: number; text: string }[] = [];
	const max = opts.max;

	// Phase 3 / WS-C1: narrow to the O(1) candidate set from reverseAdjacency
	// instead of line-scanning the whole vault. The index is coherence-refreshed
	// by getIndex, so its candidate set is reliable mid-session. Fall back to a
	// full scan only when the index is not yet built (empty) — the legacy path.
	let files: string[];
	let idx: VaultIndex | undefined;
	try {
		idx = await getIndex(vaultPath);
	} catch {
		idx = undefined;
	}
	const candidates = idx ? backlinkPaths(idx, target) : new Set<string>();
	if (idx && idx.notes.size > 0) {
		// Filter candidates by folder scope (reverseAdjacency is vault-wide).
		const folder = opts.folder ?? "";
		files = [...candidates].filter((p) => !folder || p.startsWith(folder + "/") || p === folder);
		// No candidates means no backlinks per a coherent index — return early.
		if (files.length === 0) return [];
	} else {
		files = await listNotes(vaultPath, opts.folder ?? "");
	}

	const entries = await readBatched(files.map((f) => join(vaultPath, f)));
	for (let fi = 0; fi < files.length; fi++) {
		const f = files[fi];
		if (!f) continue;
		const entry = entries[fi];
		if (!entry) continue;
		const lines = entry.lines;
		for (let i = 0; i < lines.length; i++) {
			const li = lines[i]!;
			for (const link of extractWikiLinks(li)) {
				const linkStripped = link.replace(/\.md$/i, "");
				const linkN = cmp(linkStripped);
				const linkBase = cmp(linkStripped.split("/").pop() ?? linkStripped);
				if (linkN === wantN || linkBase === wantBase) {
					results.push({ file: f, line: i + 1, text: li.trim() });
					if (results.length >= max) return results;
					break; // one match per line is enough
				}
			}
		}
	}
	return results;
}

/** Find notes carrying tag `tag` (without leading #). Matches frontmatter
 *  `tags:` arrays and inline `#tag` tokens. Returns {file, line, text}. */
export async function findTagNotes(
	vaultPath: string,
	tag: string,
	opts: { folder?: string; caseSensitive?: boolean; max: number },
): Promise<{ file: string; line: number; text: string }[]> {
	const want = tag.replace(/^#/, "").trim();
	const cmp = (s: string) => (opts.caseSensitive ? s : s.toLowerCase());
	const wantN = cmp(want);
	const inlineRe = /(^|\s)#([A-Za-z0-9_-]+)/g;
	const results: { file: string; line: number; text: string }[] = [];
	const files = await listNotes(vaultPath, opts.folder ?? "");
	const max = opts.max;
	const entries = await readBatched(files.map((f) => join(vaultPath, f)));
	for (let fi = 0; fi < files.length; fi++) {
		const f = files[fi];
		if (!f) continue;
		const entry = entries[fi];
		if (!entry) continue;
		const lines = entry.lines;
		// C1.2: parseFrontmatter recognizes flow + block-YAML tag forms.
		const { data: fm } = parseFrontmatter(entry.content);
		const fmTags: string[] = Array.isArray(fm.tags)
			? fm.tags.map(String)
			: fm.tags != null
				? [String(fm.tags)]
				: [];
		let inFm = false,
			fmDone = false,
			fmTagsLine = -1;
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
			if (inFm && /^\s*tags?\s*:/.test(l) && fmTagsLine === -1) fmTagsLine = i;
		}
		let fmHit = false;
		for (const t of fmTags)
			if (cmp(t) === wantN) {
				fmHit = true;
				break;
			}
		if (fmHit && fmTagsLine >= 0) {
			results.push({
				file: f,
				line: fmTagsLine + 1,
				text: lines[fmTagsLine]!.trim(),
			});
			if (results.length >= max) return results;
		}
		for (let i = 0; i < lines.length; i++) {
			const l = lines[i]!;
			let mm: RegExpExecArray | null;
			inlineRe.lastIndex = 0;
			while ((mm = inlineRe.exec(l))) {
				if (cmp(mm[2]!) === wantN) {
					results.push({ file: f, line: i + 1, text: l.trim() });
					if (results.length >= max) return results;
					break;
				}
			}
		}
	}
	return results;
}
