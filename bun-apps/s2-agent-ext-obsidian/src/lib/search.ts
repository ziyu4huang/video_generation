import { join } from "node:path";

import {
	listNotes,
	readBatched,
} from "./fs-cache";

export type MatchMode = "substring" | "regex" | "words" | "fuzzy";
export type NoteField = "all" | "title" | "tags" | "body" | "frontmatter";

/** True if `needle`'s characters appear in `hay` in order (not necessarily contiguous). */
export function isSubsequence(hay: string, needle: string): boolean {
	if (!needle) return true;
	let i = 0;
	for (const ch of hay) {
		if (ch === needle[i]) i++;
		if (i === needle.length) return true;
	}
	return i === needle.length;
}

/** Standard iterative Levenshtein edit distance with O(min(m,n)) rolling rows. */
export function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	let prev = new Array<number>(n + 1);
	let curr = new Array<number>(n + 1);
	for (let j = 0; j <= n; j++) prev[j] = j;
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		const ca = a.charCodeAt(i - 1);
		for (let j = 1; j <= n; j++) {
			const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
			curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
		}
		const tmp = prev;
		prev = curr;
		curr = tmp;
	}
	return prev[n]!;
}

/** Fuzzy line match. Exact substring → true; else (tol 0) ordered subsequence;
 *  else (tol ≥ 1) sliding-window edit distance ≤ tol over windows of length
 *  [len-tol, len+tol]. Used for typo-tolerant search. */
export function fuzzyMatch(line: string, q: string, tol: number): boolean {
	if (!q) return false;
	if (line.includes(q)) return true;
	if (tol <= 0) return isSubsequence(line, q);
	const m = q.length;
	for (let wlen = Math.max(1, m - tol); wlen <= m + tol; wlen++) {
		for (let i = 0; i + wlen <= line.length; i++) {
			if (levenshtein(line.slice(i, i + wlen), q) <= tol) return true;
		}
	}
	return false;
}

/** Compile a query + mode + case-sensitivity into a per-line predicate.
 *  Returns { error } on invalid regex so the caller can surface a clean message
 *  instead of throwing.
 *
 *  Modes:
 *  - substring: literal substring (the historical default; byte-identical to
 *    the old lowercased-`includes` implementation when caseSensitive=false).
 *  - regex:     JS regular expression (`new RegExp(query, flags)`).
 *  - words:     boolean. Whitespace-split tokens; `-word` = NOT (file-level:
 *    excludes any file where the term appears anywhere, not just per-line);
 *    `|` separates OR groups; tokens within a group are AND.
 *  - fuzzy:     typo-tolerant via fuzzyMatch; tolerance scales with query
 *    length (≤3 chars → 0, ≤6 → 1, else 2).
 *
 *  `fileFilter` (when present) must be applied to the entire file content
 *  before per-line matching — currently emitted only by `words` mode for NOT
 *  terms so they exclude files regardless of which line the term appears on. */
/**
 * Strip backslashes before grouping/alternation regex metacharacters. Weak LLMs
 * frequently OVER-ESCAPE (e.g. `SEARCH\(WORD\|TERM\)` meaning `SEARCH(WORD|TERM)`),
 * which compiles fine but matches the literal string and yields 0 hits. Used only
 * as a 0-match fallback in regex mode, gated on the query containing an alternation
 * `|` (a literal `|` in note prose is rare, and `|` in regex is almost always OR).
 */
export function deescapeRegex(q: string): string {
	return q.replace(/\\([()|])/g, "$1");
}

export function buildMatcher(
	query: string,
	mode: MatchMode,
	caseSensitive: boolean,
): {
	match?: (line: string) => boolean;
	fileFilter?: (content: string) => boolean;
	error?: string;
} {
	const ci = !caseSensitive;
	const norm = (s: string) => (ci ? s.toLowerCase() : s);
	switch (mode) {
		case "substring": {
			const needle = norm(query);
			return { match: (line) => norm(line).includes(needle) };
		}
		case "regex": {
			try {
				const re = new RegExp(query, ci ? "i" : "");
				return { match: (line) => re.test(line) };
			} catch (e) {
				return { error: `Invalid regex /${query}/: ${(e as Error).message}` };
			}
		}
		case "words": {
			const tokens = query.trim().split(/\s+/).filter(Boolean);
			const negatives = tokens
				.filter((t) => t.startsWith("-") && t.length > 1)
				.map((t) => norm(t.slice(1)));
			const positives = tokens.filter(
				(t) => !(t.startsWith("-") && t.length > 1),
			);
			const groups = positives
				.join(" ")
				.split("|")
				.map((g) =>
					g
						.trim()
						.split(/\s+/)
						.filter(Boolean)
						.map((t) => norm(t)),
				);
			// NOT terms are checked at file level so a term in frontmatter/title
			// correctly excludes the whole file, not just individual lines.
			const fileFilter =
				negatives.length > 0
					? (content: string) =>
							!negatives.some((neg) => norm(content).includes(neg))
					: undefined;
			return {
				match: (line) => {
					const lc = norm(line);
					// groups.some with an empty inner array ([].every) is vacuously true,
					// which is the desired behaviour for a NOT-only query: all lines of
					// non-excluded files are returned.
					return groups.some((g) => g.every((t) => lc.includes(t)));
				},
				fileFilter,
			};
		}
		case "fuzzy": {
			const q = norm(query);
			const tol = q.length <= 3 ? 0 : q.length <= 6 ? 1 : 2;
			return { match: (line) => fuzzyMatch(norm(line), q, tol) };
		}
		default:
			return { error: `Unknown matchMode: ${mode}` };
	}
}

/** Per-line (0-indexed) classification into note-section labels.
 *  - frontmatter block (incl. `---` fences) → "frontmatter"; a `tags:`/`tag:`
 *    line inside it also → "tags".
 *  - first H1 (`# ...`) → "title".
 *  - other lines → "body"; body lines with an inline `#tag` also → "tags". */
export function computeFieldLabels(lines: string[]): Set<NoteField>[] {
	const labels: Set<NoteField>[] = new Array(lines.length);
	let fmStart = -1;
	let fmEnd = -1;
	if (lines.length > 0 && lines[0]!.trim() === "---") {
		fmStart = 0;
		for (let i = 1; i < lines.length; i++) {
			if (lines[i]!.trim() === "---") {
				fmEnd = i;
				break;
			}
		}
		if (fmEnd === -1) fmStart = -1; // unterminated → no frontmatter
	}
	let titleIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (/^#\s+\S/.test(lines[i]!)) {
			titleIdx = i;
			break;
		}
	}
	const inlineTagRe = /(^|\s)#[A-Za-z0-9_-]+/;
	for (let i = 0; i < lines.length; i++) {
		const s = new Set<NoteField>();
		if (fmStart !== -1 && i >= fmStart && i <= fmEnd) {
			s.add("frontmatter");
			if (/^\s*tags?\s*:/.test(lines[i]!)) s.add("tags");
		} else if (i === titleIdx) {
			s.add("title");
		} else {
			s.add("body");
			if (inlineTagRe.test(lines[i]!)) s.add("tags");
		}
		labels[i] = s;
	}
	return labels;
}

/** One search hit, possibly enriched with field label and relevance score. */
export interface SearchMatch {
	file: string;
	line: number;
	text: string;
	/** Which note section this hit fell in (only when `enrich` / scoring is on). */
	field?: NoteField;
	/** Relevance weight of this hit (only when scoring is on). */
	score?: number;
}

/** Parse frontmatter `created:` (YYYY-MM-DD) → epoch days; 0 if absent/invalid. */
export function noteRecencyDays(content: string): number {
	// `^created:` (not `\ncreated:`) so a note whose `created:` is the FIRST
	// frontmatter key — directly after the `---\n` fence, with no preceding
	// newline — still matches. Mirrors index.ts parseNoteMeta; keep in sync.
	const m = content.match(
		/^---\n[\s\S]*?^created:\s*["']?(\d{4}-\d{2}-\d{2})/m,
	);
	if (!m) return 0;
	const t = Date.parse(m[1]!);
	return Number.isNaN(t) ? 0 : Math.floor(t / 86_400_000);
}

/** Relevance weight of a hit by field. Per plan: title +10 | tag +6 | frontmatter +3 | body +1. */
export function fieldWeight(field: NoteField | undefined): number {
	switch (field) {
		case "title":
			return 10;
		case "tags":
			return 6;
		case "frontmatter":
			return 3;
		default:
			return 1; // body / unknown
	}
}

/** Pick the most specific field label on a line for scoring. */
export function pickField(labels: Set<NoteField> | undefined): NoteField | undefined {
	if (!labels) return undefined;
	if (labels.has("title")) return "title";
	if (labels.has("tags")) return "tags";
	if (labels.has("frontmatter")) return "frontmatter";
	return "body";
}

/** Full-text search across the vault. Returns matches, optionally enriched
 *  with field labels, relevance scores, and sorted/grouped.
 *
 *  Options:
 *  - match:       per-line predicate (build via buildMatcher).
 *  - fields:      restrict eligible note sections; null/["all"] = everywhere.
 *  - folder:      restrict to a sub-tree; "" = whole vault.
 *  - context:     lines of surrounding context per match (0 = single line).
 *                When >0, the match `text` is replaced by an indented `> ` block
 *                showing [lo..hi] lines with the hit line marked `> `.
 *  - sort:        "file" (default: alphabetical traversal order) | "relevance"
 *                | "recency". relevance ranks by summed field weight per file
 *                then by per-hit weight; recency by frontmatter `created:` desc.
 *  - groupByFile: collapse to at most `perFile` matches per file (default false).
 *  - perFile:     max matches to keep per file when groupByFile (default 3).
 *  - max:         hard cap on total returned matches; early return.
 *  - enrich:      populate `field` + `score` on each match. Auto-enabled when
 *                sort is "relevance". Default false keeps results lean.
 *
 *  Default behavior (match + fields:null + folder:"" + context:0 + sort:"file"
 *  + groupByFile:false + enrich:false) is byte-identical to the historical
 *  implementation: {file,line,text} in alphabetical traversal order, hard-capped. */
export async function searchVault(
	vaultPath: string,
	opts: {
		match: (line: string) => boolean;
		/** Optional file-level pre-filter. When present, files for which this
		 *  returns false are skipped entirely before per-line matching. Used by
		 *  `words` mode to apply NOT exclusions at file scope. */
		fileFilter?: (content: string) => boolean;
		fields: NoteField[] | null;
		folder: string;
		context?: number;
		sort?: "file" | "relevance" | "recency";
		groupByFile?: boolean;
		perFile?: number;
		max: number;
		enrich?: boolean;
		/** B4.3: restrict matching to this exact set of vault-relative paths
		 *  (e.g. pipe in queryNotes() output). When set, `folder` is ignored. */
		paths?: string[];
	},
): Promise<SearchMatch[]> {
	const allowedPaths = opts.paths ? new Set(opts.paths) : null;
	// Phase 6 validation: when an explicit path set is given, skip the O(n)
	// listNotes readdir — the caller (e.g. C5 trigram candidates) has already
	// scoped the search, and listNotes otherwise dominated wall-time on large
	// vaults, masking the trigram win. When a folder restriction is ALSO in
	// play, intersect it with the candidate set by prefix (the candidates are
	// vault-relative paths) rather than re-enumerating the vault — otherwise a
	// folder-scoped substring search silently loses the C5 speedup. Falls back
	// to listNotes only when there is no explicit path set (unscoped search).
	const folder = opts.folder ?? "";
	const inFolder = (p: string) => !folder || p.startsWith(folder + "/") || p === folder;
	const files = allowedPaths
		? [...allowedPaths].filter(inFolder)
		: await listNotes(vaultPath, opts.folder);
	const fieldFilter =
		opts.fields && !opts.fields.includes("all") ? new Set(opts.fields) : null;
	const contextN = opts.context ?? 0;
	const sort = opts.sort ?? "file";
	const groupByFile = opts.groupByFile ?? false;
	const perFile = opts.perFile ?? 3;
	const enrich = opts.enrich ?? sort === "relevance";
	const max = opts.max;

	// Need per-line field labels when filtering by field OR scoring/enriching.
	const needLabels = !!fieldFilter || enrich;

	// file -> matches (in traversal order). Keep raw line indices + content for context.
	const byFile = new Map<string, { i: number; m: SearchMatch }[]>();
	const fileLines = new Map<string, string[]>(); // for context rendering
	const fileRecency = new Map<string, number>(); // for recency sort

	// Parallel cached reads (Phase 3). `files` is already alphabetical; readBatched
	// preserves order so the default "file" sort stays identical to the old impl.
	const entries = await readBatched(files.map((f) => join(vaultPath, f)));
	for (let fi = 0; fi < files.length; fi++) {
		const f = files[fi];
		if (!f) continue;
		if (allowedPaths && !allowedPaths.has(f)) continue;
		const entry = entries[fi];
		if (!entry) continue;
		// File-level pre-filter (e.g. words mode NOT exclusion).
		if (opts.fileFilter && !opts.fileFilter(entry.content)) continue;
		const lines = entry.lines;
		if (sort === "recency") fileRecency.set(f, noteRecencyDays(entry.content));
		const labels = needLabels ? computeFieldLabels(lines) : null;

		for (let i = 0; i < lines.length; i++) {
			let lineLabels: Set<NoteField> | undefined;
			if (needLabels) {
				lineLabels = labels![i];
				if (!lineLabels) continue;
				if (fieldFilter) {
					let eligible = false;
					for (const lf of lineLabels)
						if ((fieldFilter as Set<NoteField>).has(lf)) {
							eligible = true;
							break;
						}
					if (!eligible) continue;
				}
			}
			const li = lines[i]!;
			if (!opts.match(li)) continue;

			const field = enrich ? pickField(lineLabels) : undefined;
			const m: SearchMatch = {
				file: f,
				line: i + 1,
				text: li.trim(),
				field,
				score: enrich ? fieldWeight(field) : undefined,
			};
			if (!enrich) {
				delete m.field;
				delete m.score;
			}
			let arr = byFile.get(f);
			if (!arr) {
				arr = [];
				byFile.set(f, arr);
			}
			arr.push({ i, m });
			if (contextN > 0 && !fileLines.has(f)) fileLines.set(f, lines);
		}
	}

	// Order files per chosen sort.
	let orderedFiles: string[];
	if (sort === "relevance") {
		orderedFiles = [...byFile.keys()].sort((a, b) => {
			const sa = (byFile.get(a) ?? []).reduce(
				(s, e) => s + (e.m.score ?? 0),
				0,
			);
			const sb = (byFile.get(b) ?? []).reduce(
				(s, e) => s + (e.m.score ?? 0),
				0,
			);
			return sb - sa || a.localeCompare(b);
		});
	} else if (sort === "recency") {
		orderedFiles = [...byFile.keys()].sort(
			(a, b) =>
				(fileRecency.get(b) ?? 0) - (fileRecency.get(a) ?? 0) ||
				a.localeCompare(b),
		);
	} else {
		orderedFiles = [...byFile.keys()]; // Map preserves insertion = alphabetical traversal
	}

	const results: SearchMatch[] = [];
	for (const f of orderedFiles) {
		const arr = byFile.get(f) ?? [];
		// For relevance, also order hits within a file by score desc.
		const orderedHits =
			sort === "relevance"
				? [...arr].sort(
						(a, b) => (b.m.score ?? 0) - (a.m.score ?? 0) || a.i - b.i,
					)
				: arr;
		const kept = groupByFile ? orderedHits.slice(0, perFile) : orderedHits;

		for (const { i, m } of kept) {
			if (contextN > 0) {
				const ls = fileLines.get(f);
				if (ls) m.text = renderContext(ls, i, contextN, m.text);
			}
			results.push(m);
			if (results.length >= max) return results;
		}
	}
	return results;
}

/** Render a context snippet: lines [i-n .. i+n], hit line prefixed `> `, others `  `. */
export function renderContext(
	lines: string[],
	i: number,
	n: number,
	hitText: string,
): string {
	const lo = Math.max(0, i - n);
	const hi = Math.min(lines.length - 1, i + n);
	const out: string[] = [];
	for (let j = lo; j <= hi; j++) {
		const raw = lines[j]!;
		const t = raw.trim();
		if (j === i) out.push(`> ${hitText}`);
		else out.push(`  ${t}`);
	}
	return out.join("\n");
}
