/**
 * Obsidian Extension (project-local vault)
 *
 * Defaults to a vault located at `<cwd>/vault/` (auto-created). This keeps the
 * knowledge base next to the code project. Override the subfolder name with
 * OB_VAULT_DIR (relative to cwd) or point elsewhere with OB_VAULT_PATH
 * (absolute) / OB_VAULT (registered vault name from obsidian.json).
 *
 * Tools:
 *   - obsidian_list           : list notes under a folder
 *   - obsidian_read           : read a note
 *   - obsidian_create         : create or overwrite a note
 *   - obsidian_append         : append text to a note
 *   - obsidian_append_section : insert text under a specific heading (creates heading if missing)
 *   - obsidian_search         : full-text grep across the vault (returns file:line matches)
 *   - obsidian_open           : open a note / vault in the Obsidian app
 *   - obsidian_distill        : distill input markdown into Zettelkasten notes (subagent)
 *   - obsidian_garden          : audit/repair vault health (subagent)
 *
 * Commands:
 *   - /obsidian [note]        : open vault or note in Obsidian
 *   - /obsidian-init          : register the project vault with the Obsidian app
 *
 * Wiki-link syntax ([[Target]]) works natively because notes are plain markdown.
 */

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import {
	join,
	resolve,
	sep,
	relative,
} from "node:path";
import {
	readFile,
	writeFile,
	mkdir,
	readdir,
	mkdtemp,
	rm,
	stat,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Phase 1 barrel: leaf modules re-exported so existing `from "./obsidian-lib"`
// / `from "../src/obsidian-lib.ts"` imports keep resolving after extraction.
// Note: `export *` re-exports to external consumers but does NOT create local
// bindings, so symbols used *within* this file are imported explicitly.
import {
	VaultError,
	classifyFsError,
	fsErrCode,
	errMsg,
} from "./lib/errors";
export * from "./lib/errors";

export * from "./lib/utils";

import {
	safeNotePath,
	assertWithinVault,
	assertWritablePath,
} from "./lib/path-safety";
export * from "./lib/path-safety";

import {
	atomicWriteFile,
	renameOverwrite,
	noteMtime,
	mtimeConflict,
	readCached,
	invalidateCache,
	readBatched,
	listNotes,
} from "./lib/fs-cache";
export * from "./lib/fs-cache";

export * from "./lib/vault-resolution";

import { parseFrontmatter, updateFrontmatter } from "./lib/frontmatter";
export * from "./lib/frontmatter";

import { type VaultIndex, getIndex, resolveLink, dropIndex } from "./lib/index";
export * from "./lib/index";

export * from "./lib/search";

// Structured error helpers (errMsg, ErrCode, VaultError, fsErrCode,
// classifyFsError, toolError, toolErrorFromCaught) live in ./lib/errors and are
// re-exported via the barrel at the top of this file.

/** Match [[Target]] wiki-links on a line. Returns the inner target strings.
 *  Handles display aliases `[[Target|Display]]` and path targets `[[A/B/C]]`. */
export function extractWikiLinks(line: string): string[] {
	const re = /\[\[([^\]]+)\]\]/g;
	const out: string[] = [];
	let mm: RegExpExecArray | null;
	while ((mm = re.exec(line))) {
		let target = mm[1]!;
		const pipe = target.indexOf("|");
		if (pipe !== -1) target = target.slice(0, pipe); // drop alias
		target = target.replace(/#.*$/, "").trim(); // drop heading ref
		if (target) out.push(target);
	}
	return out;
}

/** Resolve a tool-name allowlist from an env var (comma-separated), falling
 *  back to `defaults` when unset/empty. Used by distill/garden so a custom
 *  workflow can override the tool set without code changes (Phase 5 / WS-B6).
 *  Empty/whitespace-only entries are dropped; an all-empty value falls back. */
export function toolAllowlist(envVar: string, defaults: string[]): string[] {
	const raw = process.env[envVar];
	if (!raw || !raw.trim()) return defaults;
	const parsed = raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return parsed.length > 0 ? parsed : defaults;
}

/** Phase 5 / WS-C8 — verify the host satisfies the ExtensionAPI contract.
 *  `core` methods are hard-required (their absence means the extension can't
 *  function → throw); `secondary` methods are warned about, not fatal, so a
 *  forward-compatible host that dropped an unused hook isn't blocked. */
export function assertExtensionApi(pi: any): void {
	const core = ["registerTool"];
	const secondary = ["registerCommand", "on"];
	const missingCore = core.filter((m) => typeof pi?.[m] !== "function");
	if (missingCore.length > 0) {
		throw new Error(
			`pi-obsidian: host does not satisfy the ExtensionAPI contract — missing core method(s): ${missingCore.join(", ")}. ` +
				`Ensure @earendil-works/pi-coding-agent is up to date (the host vendors an inline copy of ExtensionAPI).`,
		);
	}
	const missingSecondary = secondary.filter((m) => typeof pi?.[m] !== "function");
	if (missingSecondary.length > 0) {
		console.error(
			`pi-obsidian: warning — host ExtensionAPI is missing secondary method(s): ${missingSecondary.join(", ")} (commands/events will be unavailable but tools still register).`,
		);
	}
}

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

// ---- Structured editing (B3) -----------------------------------------------

/** Rewrite a single wiki-link reference, preserving alias and #section.
 *  Returns the new [[...]] form, or the original if it doesn't match the old target. */
export function rewriteLinkToken(
	raw: string,
	oldPaths: string[],
	newTitle: string,
	newPath: string,
	idx: VaultIndex,
): string {
	// raw is the inside of [[...]]
	let target = raw;
	const pipe = target.indexOf("|");
	let alias = "";
	if (pipe !== -1) {
		alias = target.slice(pipe);
		target = target.slice(0, pipe);
	}
	let section = "";
	const hash = target.indexOf("#");
	if (hash !== -1) {
		section = target.slice(hash);
		target = target.slice(0, hash);
	}
	const t = target.replace(/\.md$/i, "").toLowerCase();
	const isMatch = oldPaths.some(
		(p) =>
			p.toLowerCase() === t ||
			p.toLowerCase().split("/").pop() === t.split("/").pop(),
	);
	if (!isMatch) return raw;
	const qualified = newPath.replace(/\.md$/i, "");
	const bare = newTitle;
	const useBare =
		idx.byTitle.has(bare.toLowerCase()) &&
		idx.byTitle.get(bare.toLowerCase()) === newPath;
	return (useBare ? bare : qualified) + section + alias;
}

// ---- Wiki-link rewrite protection (Phase 1: WS-A3) ------------------------
// move/delete rewrite inbound [[links]] across the vault. Doing that with a
// naive content.replace() corrupts regions where [[..]] is NOT a real link:
// the YAML frontmatter block, fenced code blocks, and inline `code` spans.
// rewriteLinksProtected() runs the per-link decision only over safe text.
export const LINK_KEEP = Symbol("@repo/pi-agent-ext-obsidian/link-keep");
export const LINK_DELETE = Symbol("@repo/pi-agent-ext-obsidian/link-delete");

/** Apply a per-[[link]] rewriter to file content, PROTECTING frontmatter,
 *  fenced code blocks (``` / ~~~), and inline `code` spans. The rewriter
 *  receives the raw inside of [[...]] and returns:
 *    - a string  → replace the token with [[that string]]
 *    - LINK_KEEP → leave the token untouched
 *    - LINK_DELETE → remove the token entirely (used by delete cleanup) */
export function rewriteLinksProtected(
	content: string,
	rewriter: (rawInner: string) => string | typeof LINK_KEEP | typeof LINK_DELETE,
): string {
	const linkRe = /\[\[([^\]]+)\]\]/g;
	const apply = (text: string): string =>
		text.replace(linkRe, (full, raw) => {
			const decision = rewriter(String(raw));
			if (decision === LINK_KEEP) return full;
			if (decision === LINK_DELETE) return "";
			return `[[${String(decision)}]]`;
		});
	/** Rewrite a single line, leaving inline `code` spans untouched. */
	const rewriteLine = (line: string): string => {
		let out = "";
		let last = 0;
		const inlineRe = /`[^`]*`/g;
		let m: RegExpExecArray | null;
		while ((m = inlineRe.exec(line))) {
			out += apply(line.slice(last, m.index)) + m[0];
			last = m.index + m[0].length;
		}
		out += apply(line.slice(last));
		return out;
	};

	const lines = content.split("\n");
	const out: string[] = [];
	let inFence = false;
	let fenceChar: string | null = null;
	let inFm = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		// Frontmatter: a leading "---" fence at the very top of the file.
		if (i === 0 && line.trim() === "---") {
			inFm = true;
			out.push(line);
			continue;
		}
		if (inFm) {
			if (line.trim() === "---" || line.trim() === "...") inFm = false;
			out.push(line); // protected
			continue;
		}
		// Fenced code block open/close (``` or ~~~, 3+, ≤3 leading spaces).
		const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
		if (fence) {
			const ch = fence[1]![0]!;
			if (!inFence) {
				inFence = true;
				fenceChar = ch;
			} else if (ch === fenceChar) {
				inFence = false;
				fenceChar = null;
			}
			out.push(line); // fence line protected
			continue;
		}
		if (inFence) {
			out.push(line); // protected
			continue;
		}
		out.push(rewriteLine(line));
	}
	return out.join("\n");
}

/** Move/rename a note and rewrite all inbound [[links]] (B3.1 + B3.2). */
export async function moveNote(
	vaultPath: string,
	from: string,
	to: string,
	opts: { overwrite?: boolean } = {},
): Promise<{
	moved: boolean;
	from: string;
	to: string;
	linksRewritten: string[];
	failedSources: string[];
}> {
	const real = resolve(vaultPath);
	const fromAbs = safeNotePath(real, from);
	const toAbs = safeNotePath(real, to);
	assertWritablePath(real, fromAbs);
	assertWritablePath(real, toAbs);
	await assertWithinVault(real, fromAbs);
	await assertWithinVault(real, toAbs);
	try {
		await stat(toAbs);
		if (!opts.overwrite)
			throw new Error(`Destination exists: ${to} (pass overwrite:true)`);
	} catch (e: any) {
		if (e instanceof Error && e.message.startsWith("Destination")) throw e;
	}
	const idx = await getIndex(real);
	const fromPath = from.replace(/\.md$/i, "") + ".md";
	const newPath = to.replace(/\.md$/i, "") + ".md";
	const fromMeta = idx.notes.get(fromPath);
	const fromTitle =
		fromMeta?.title ??
		fromPath.split("/").pop()!.replace(/\.md$/i, "").toLowerCase();
	const sources = backlinkPaths(idx, fromTitle);
	const linksRewritten: string[] = [];
	const failedSources: string[] = [];
	// Move the file FIRST. If the rename fails (EXDEV, read-only FS, mkdir
	// failure, destination race), we bail out before touching any backlink, so
	// the graph stays intact — links still resolve to the existing source note —
	// instead of all pointing at a destination that was never created.
	await mkdir(join(toAbs, ".."), { recursive: true });
	await renameOverwrite(fromAbs, toAbs);
	invalidateCache(fromAbs);
	invalidateCache(toAbs);
	for (const src of sources) {
		const srcAbs = join(real, src);
		try {
			const entry = await readCached(srcAbs);
			if (!entry) continue;
			let changed = false;
			const updated = rewriteLinksProtected(entry.content, (raw) => {
				const after = rewriteLinkToken(
					raw,
					[fromPath, fromTitle],
					fromTitle,
					newPath,
					idx,
				);
				if (after !== raw) {
					changed = true;
					return after;
				}
				return LINK_KEEP;
			});
			if (changed) {
				await atomicWriteFile(srcAbs, updated);
				invalidateCache(srcAbs);
				linksRewritten.push(src);
			}
		} catch (e) {
			failedSources.push(src);
		}
	}
	dropIndex(real);
	return {
		moved: true,
		from: fromPath,
		to: newPath,
		linksRewritten,
		failedSources,
	};
}

/** Delete a note and optionally strip inbound [[links]] (B3.4). */
export async function deleteNote(
	vaultPath: string,
	note: string,
	opts: { cleanupLinks?: boolean } = {},
): Promise<{ deleted: boolean; note: string; linksCleaned: string[] }> {
	const real = resolve(vaultPath);
	const abs = safeNotePath(real, note);
	assertWritablePath(real, abs);
	await assertWithinVault(real, abs);
	const cleanup = opts.cleanupLinks ?? true;
	const notePath = note.replace(/\.md$/i, "") + ".md";
	const linksCleaned: string[] = [];
	if (cleanup) {
		const idx = await getIndex(real);
		// Wiki-links target a note's FILENAME (basename), not its H1 title — links are
		// keyed in reverseAdjacency by the lowercased raw link target. Using meta.title
		// here missed [[filename]] refs whenever title !== filename (e.g. "# Old Draft"
		// inside OldDraft.md). Resolve by basename, matching how links are actually keyed.
		const target = notePath.split("/").pop()!.replace(/\.md$/i, "");
		const sources = backlinkPaths(idx, target);
		for (const src of sources) {
			const srcAbs = join(real, src);
			const entry = await readCached(srcAbs);
			if (!entry) continue;
			const tLower = target.toLowerCase();
			let changed = false;
			const updated = rewriteLinksProtected(entry.content, (raw) => {
				const tgt = raw
					.replace(/\|.*/, "")
					.replace(/#.*/, "")
					.replace(/\.md$/i, "")
					.trim()
					.toLowerCase();
				if (
					tgt === tLower ||
					tgt.split("/").pop() === tLower.split("/").pop()
				) {
					changed = true;
					return LINK_DELETE;
				}
				return LINK_KEEP;
			});
			if (changed) {
				const tidied = updated
					.split("\n")
					.filter((l, i, arr) => {
						const trimmed = l.trim();
						if (trimmed === "") {
							const prev = arr[i - 1]?.trim() ?? "x";
							const next = arr[i + 1]?.trim() ?? "x";
							return !(prev === "" && next === "");
						}
						return true;
					})
					.join("\n");
				await atomicWriteFile(srcAbs, tidied);
				invalidateCache(srcAbs);
				linksCleaned.push(src);
			}
		}
	}
	await rm(abs, { force: true });
	invalidateCache(abs);
	dropIndex(real);
	return { deleted: true, note: notePath, linksCleaned };
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
		candidates = candidates.filter(
			(m) => m.path.startsWith(folder + "/") || m.path.startsWith(folder),
		);
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

// ---- Zettelkasten distillation subagent ----------------------------------

/** System prompt that turns the child `pi` process into a Zettelkasten distiller.
 *  Encodes the full methodology: atomic decomposition, the exact output template,
 *  whole-vault linking, MOC update, Traditional Chinese output. */
export const ZETTEL_SYSTEM_PROMPT = `你是一名 Zettelkasten 蒸餾助手。你的任務：把給定的輸入文件分解成「一個原子化想法 = 一張卡」的 Zettelkasten 筆記，寫入專案本地的 Obsidian vault。

## 核心原則
1. **原子化**：每張卡只承載一個可獨立成立、能被單獨引用的論點。若一段內容含多個獨立主張，拆成多張卡。
2. **用自己的話寫**：核心想法必須改寫重述，不是逐字抄錄來源。
3. **互聯**：每張卡的「## 連結」段落至少一條 wiki-link。先用 obsidian 工具（action:"search"）搜尋整個 vault 既存筆記，找出語義相關者，用 [[筆記標題]] 連結（取不含 .md 的檔名）。
4. **繁體中文輸出**：所有卡片內容以繁體中文撰寫（專有名詞、程式碼保留原文）。

## 處理流程（依序執行）
### ① 讀取與拆解
用 read 工具讀取指定的輸入檔。通讀後，列出所有可獨立成立的原子想法（不要重寫內容，只標邊界）。

### ② 逐張萃取
對每個原子想法，建立一張卡片，呼叫 obsidian 工具（action:"create"）寫入 vault 的指定資料夾。

### ③ 連結
對每張新卡，呼叫 obsidian 工具（action:"search"）搜尋整個 vault（不只 Zettelkasten/）找相關既存筆記，在「## 連結」段落填入 wiki-link。

### ④ 更新 MOC
每建好一張卡，用 obsidian 工具（action:"append_section"）把它的 wiki-link 加進 Tags/Index.md 對應的 tag 段落（若該 tag 段落不存在，先加段落標題）。

## 嚴格輸出格式（每張卡都必須完全符合此範本）
檔名：vault 的 <輸出資料夾>/<標題>.md，標題簡潔、首字母大寫、不含斜線。
\`\`\`
---
id: <YYYYMMDDHHmm 時間戳，每張卡不同>
created: <YYYY-MM-DD>
tags: [zettel, <主題1>, <主題2>]
sources: ["<輸入檔檔名或來源>"]
---

# <這張卡的原子化標題：一個論點>

## 核心想法
- <用你自己的話，2-4 句陳述這張卡的主張>

## 證據 / 脈絡
- <來源文件的支撐細節、範例、引用，可多條>

## 連結
- 相關：[[<既存筆記A>]]
- 延伸：[[<既存筆記B>]]
- 上層概念：[[Tags/Index#<主題tag>]]
\`\`\`

## 輸入大小指引（重要）
- 一張卡的蒸餾約略對應來源 1–3 段文字。若輸入檔很大（粗估超過 ~12KB，或明顯多於十幾個段落），**不要一次通讀後草草萃取**——會漏掉尾段。
- 改成分批處理：先完整萃取前半部的原子想法，逐張建立；再用 obsidian 工具（action:"read"）重新定位到未處理的段落繼續。每張卡仍須獨立、互連。
- 你無法精確量位元組，請用「段落數 / 是否出現捲動」當粗略指引，寧可多建一張卡也不要丟失論點。

## 範例卡（gold standard — 輸出請對齊此結構）
以下是「原子化筆記與互連」一張理想卡的長相（frontmatter 完整、用自己的話、至少一條已解析的 wiki-link）：
\`\`\`
---
id: 202607010930
created: 2026-07-01
tags: [zettel, 知識管理, 筆記法]
sources: ["input.md"]
---

# 原子化筆記優先於主題資料夾

## 核心想法
- 筆記的價值來自單一論點能被獨立引用與重組，而非被歸進某個資料夾就固定不動；原子化讓連結成為主要結構，資料夾只是輔助。

## 證據 / 脈絡
- 來源指出：把多個主張塞進同一張筆記，會讓它既難被引用也難被連結。
- 互連的密度比分類的整齊更能反映思考網絡。

## 連結
- 相關：[[Zettelkasten 方法概論]]
- 延伸：[[雙向連結與圖譜密度]]
- 上層概念：[[Tags/Index#知識管理]]
\`\`\`

## 規則
- tags[0] 永遠是 zettel。
- 每張卡 id 不可重複（用當下時間，逐張遞增分鐘）。
- 不重複建立內容相同的卡（若與既存卡語義高度重疊，仍建新卡但務必互連）。
- 只用提供的工具，不要使用 bash 或寫 vault 以外的路徑。

## 完成後（重要）
先以繁體中文回報：共建了幾張卡、逐張列出檔名與一句話摘要、指出建立的主要連結。簡潔即可。

**最後一行必須是一條結構化 JSON**（供父代理解析），格式如下，獨占一行，不要用 markdown 包裹：

    {"type":"pi_obsidian_result","notesCreated":<數字>,"notesUpdated":<數字>,"linksAdded":<數字>,"notes":["相對 vault 的檔名"],"errors":["若有的話"]}

若無法填的字段填 0 或空陣列。這條 JSON 是給程式讀的，不是給人讀的。`;

/** Resolve the `pi` launcher + args for a child process (mirrors official subagent helper). */
export function getPiInvocation(extra: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtual && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...extra] };
	}
	const execName = (process.execPath.split(sep).pop() ?? "").toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName))
		return { command: process.execPath, args: extra };
	return { command: "pi", args: extra };
}

/**
 * Optional overrides for a spawned subagent. Without these the child uses the
 * pi default model and the caller-curated tool set; passing them lets an
 * extension tool control its subagent the same way the CLI does via
 * --model / --exclude-tools.
 */
export interface SubagentOptions {
	/** Model id, `provider/id`, or `provider/id:thinking` → child `--model`. */
	model?: string;
	/** Tool names to deny the child → child `--exclude-tools` (joined CSV). */
	excludeTools?: string[];
	/** Live-event observer: invoked for every parsed NDJSON event the child
	 *  emits (tool_execution_start/end, message_update, message_end, …). Use to
	 *  surface progress (see makeSubagentProgressLogger). Default: no-op. */
	onEvent?: (event: any) => void;
}

/** Build a live progress logger for a subagent run. Prints compact lines to
 *  stderr so long-running distill/garden runs are observable: confirms the
 *  subagent started, reports each note created, and exposes final tallies.
 *  Returns `{ onEvent, stats }` — pass `onEvent` as SubagentOptions.onEvent
 *  and read `stats()` after the run for a summary line. */
export function makeSubagentProgressLogger(label: string): {
	onEvent: (event: any) => void;
	stats: () => { created: number; failed: number; toolCalls: number };
} {
	let started = false;
	let created = 0;
	let failed = 0;
	let toolCalls = 0;
	const onEvent = (event: any) => {
		if (!event || typeof event.type !== "string") return;
		if (!started) {
			started = true;
			console.error(`  [${label}] subagent started`);
		}
		// The fat `obsidian` tool funnels every action through one toolName, and
		// --mode json may not stream tool_execution_start args — so detect a create
		// by its RESULT on tool_execution_end (create returns "Wrote <note> (N bytes)";
		// append/update front their own verbs). tool_execution_end reliably carries
		// toolName + result. This counter is live/best-effort — the authoritative
		// tally comes from the child's trailing pi_obsidian_result JSON.
		if (event.type === "tool_execution_end" && event.toolName === "obsidian") {
			toolCalls++;
			const resultText =
				typeof event.result === "string"
					? event.result
					: event.result?.content?.[0]?.text ?? event.result?.text ?? "";
			if (!event.isError && typeof resultText === "string" && resultText.startsWith("Wrote ")) {
				created++;
				console.error(`  [${label}] +note #${created}`);
			}
		}
	};
	return { onEvent, stats: () => ({ created, failed, toolCalls }) };
}

/**
 * Build the pi-compatible argv for a subagent child process. Pure function —
 * extracted from runSubagent so the flag wiring is unit-testable without
 * spawning a process. The caller appends the task (positional) as the last arg.
 */
export function buildSubagentArgs(
	toolsCsv: string,
	promptPath: string,
	pkgRoot: string,
	opts: SubagentOptions = {},
): string[] {
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--approve",
		"-e",
		pkgRoot,
		"--tools",
		toolsCsv,
		"--append-system-prompt",
		promptPath,
	];
	if (opts.model) args.push("--model", opts.model);
	if (opts.excludeTools && opts.excludeTools.length > 0) {
		args.push("--exclude-tools", opts.excludeTools.join(","));
	}
	return args;
}

// ---- Subagent model resolution (Phase 2 / WS-B2) --------------------------
// A subagent's model was previously inherited blindly from OB_PARENT_MODEL.
// A weak/TC-unaware parent model silently degrades distill/garden output. We
// now: honor an explicit per-call model; fall back to a configured floor
// (OB_SUBAGENT_MODEL); refuse to INHERIT a known-weak parent model; and warn
// when no model is configured at all. The floor for TC-aware distill/garden is
// a config decision (open question #2 in the PRD) — OB_SUBAGENT_MODEL is the
// mechanism; weak-detection is pattern-based so it doesn't hardcode an id.

/** Substring patterns that mark a model as "weak" (small/fast tiers that are a
 *  poor floor for the TC-heavy distill/garden prompts). Used only to REFUSE
 *  inheritance and to WARN on explicit selection — never to silently clear an
 *  explicit caller choice. */
export const WEAK_MODEL_PATTERNS = [
	/haiku/i,
	/mini/i,
	/nano/i,
	/\bsmall\b/i,
	/-lite\b/i,
	/flash/i,
	/tiny/i,
	/nano[-_]?code/i,
];

/** Is this model id a known-weak tier? (substring match on the id.) */
export function isWeakModel(modelId: string | undefined): boolean {
	if (!modelId) return false;
	return WEAK_MODEL_PATTERNS.some((re) => re.test(modelId));
}

export interface ResolvedModel {
	model: string | undefined;
	/** Where the resolution came from — surfaced for logging/diagnostics. */
	source: "explicit" | "floor" | "inherited" | "default";
	warned: boolean;
}

/** Resolve the subagent model per WS-B2. Pure function — unit-tested without
 *  spawning. Resolution order:
 *    1. opts.model            (explicit — caller's choice; warn if weak)
 *    2. OB_SUBAGENT_MODEL     (configured floor — trusted, no weakness check)
 *    3. OB_PARENT_MODEL       (inherited — REFUSED if weak)
 *    4. undefined             (pi default — warn that no model is configured) */
export function resolveSubagentModel(opts: SubagentOptions = {}): ResolvedModel {
	const warn = (m: string) => console.error(`  [subagent] ⚠ ${m}`);
	// 1. Explicit per-call model: honor it, but warn on a known-weak choice.
	if (opts.model) {
		if (isWeakModel(opts.model))
			warn(`explicit model "${opts.model}" looks like a weak tier for TC distill/garden`);
		return { model: opts.model, source: "explicit", warned: isWeakModel(opts.model) };
	}
	// 2. Configured floor (OB_SUBAGENT_MODEL) — trusted; not weakness-checked.
	const floor = process.env.OB_SUBAGENT_MODEL;
	if (floor) return { model: floor, source: "floor", warned: false };
	// 3. Inherited parent model — refuse if known-weak so a parent `--model`
	//    selection can't silently degrade every spawned subagent.
	const parent = process.env.OB_PARENT_MODEL;
	if (parent) {
		if (isWeakModel(parent)) {
			warn(`refusing to inherit weak parent model "${parent}"; falling back to pi default`);
			return { model: undefined, source: "default", warned: true };
		}
		return { model: parent, source: "inherited", warned: false };
	}
	// 4. Nothing configured — let pi pick its default, but surface that no
	//    explicit/floor model is set so the operator can tune OB_SUBAGENT_MODEL.
	warn("no subagent model configured (set OB_SUBAGENT_MODEL for a stable TC-aware floor)");
	return { model: undefined, source: "default", warned: true };
}

/** Spawn a child pi (isolated context) as a specialized subagent.
 *  Loads this extension (-e) so obsidian tools are available in any cwd,
 *  restricts tools, appends the given system prompt, and runs the task.
 *  Returns the child's final assistant text + exit status. */

/** A3.4: extract a trailing structured-result JSON object from assistant text.
 *  Looks for the LAST line that parses to an object with type 'pi_obsidian_result'.
 *  Returns the parsed object, or null if none found. Exported for testing. */
export function parseStructuredResult(text: string): any {
	if (!text) return null;
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!;
		const trimmed = line.trim();
		if (!trimmed.startsWith("{") || !trimmed.includes("pi_obsidian_result"))
			continue;
		try {
			const obj = JSON.parse(trimmed);
			if (obj && obj.type === "pi_obsidian_result") return obj;
		} catch {
			/* not valid JSON, keep scanning */
		}
	}
	return null;
}

export function runSubagentWithRetry(
	cwd: string,
	systemPrompt: string,
	task: string,
	toolsCsv: string,
	signal: AbortSignal | undefined,
	tmpPrefix = "pi-subagent-",
	opts: SubagentOptions = {},
): Promise<{
	output: string;
	exitCode: number;
	stderr: string;
	timedOut: boolean;
	result: any;
	attempts: number;
}> {
	return runSubagentWithRetryImpl(
		cwd,
		systemPrompt,
		task,
		toolsCsv,
		signal,
		tmpPrefix,
		1,
		opts,
	);
}

/** Heuristic: does this stderr indicate a transient (retryable) failure? (A3.5) */
export function isTransientError(stderr: string, exitCode: number): boolean {
	if (exitCode === 0) return false;
	if (!stderr) return false;
	const s = stderr.toLowerCase();
	const signals = [
		"etimedout",
		"econnreset",
		"econnrefused",
		"enotfound",
		"socket hang up",
		"timeout",
		"rate limit",
		"429",
		"503",
		"502",
		"network",
		"fetch failed",
		"eai_again",
	];
	return signals.some((sig) => s.includes(sig));
}

export async function runSubagentWithRetryImpl(
	cwd: string,
	systemPrompt: string,
	task: string,
	toolsCsv: string,
	signal: AbortSignal | undefined,
	tmpPrefix: string,
	attempt: number,
	opts: SubagentOptions = {},
): Promise<{
	output: string;
	exitCode: number;
	stderr: string;
	timedOut: boolean;
	result: any;
	attempts: number;
}> {
	const res = await runSubagent(
		cwd,
		systemPrompt,
		task,
		toolsCsv,
		signal,
		tmpPrefix,
		opts,
	);
	// Retry once on transient error AND no useful output.
	if (
		res.exitCode !== 0 &&
		!res.output &&
		!res.timedOut &&
		attempt === 1 &&
		isTransientError(res.stderr, res.exitCode)
	) {
		const retry = await runSubagent(
			cwd,
			systemPrompt,
			task,
			toolsCsv,
			signal,
			tmpPrefix,
			opts,
		);
		return { ...retry, attempts: 2 };
	}
	return { ...res, attempts: attempt };
}

export async function runSubagent(
	cwd: string,
	systemPrompt: string,
	task: string,
	toolsCsv: string,
	signal: AbortSignal | undefined,
	tmpPrefix = "pi-subagent-",
	opts: SubagentOptions = {},
): Promise<{
	output: string;
	exitCode: number;
	stderr: string;
	timedOut: boolean;
	result: any;
}> {
	// Phase 2 / WS-B2: resolve a validated model instead of blindly inheriting
	// OB_PARENT_MODEL. The resolution logs warnings itself (weak/explicit,
	// refused inheritance, unset) — so the parent surfaces a degrading choice.
	const resolved = resolveSubagentModel(opts);
	let tmpDir: string | null = null;
	let timer: NodeJS.Timeout | undefined;
	let timedOut = false;
	const timeoutMs = Number(process.env.OB_SUBAGENT_TIMEOUT_MS ?? 5 * 60_000);
	try {
		tmpDir = await mkdtemp(join(tmpdir(), tmpPrefix));
		const promptPath = join(tmpDir, "system.md");
		await writeFile(promptPath, systemPrompt, { mode: 0o600 });
		// Explicitly load this extension in the child so obsidian tools are
		// available regardless of whether the cwd has a .pi/settings.json.
		const pkgRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
		// Phase 2 / WS-B2: model comes from resolveSubagentModel (validated
		// floor/explicit; weak parent inheritance refused) rather than a raw
		// `opts.model ?? OB_PARENT_MODEL`.
		const inherited: SubagentOptions = { ...opts, model: resolved.model };
		// Argv is built by a pure helper (unit-tested); task is the last positional.
		const args = [...buildSubagentArgs(toolsCsv, promptPath, pkgRoot, inherited), task];
		const inv = getPiInvocation(args);
		const proc = spawn(inv.command, inv.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		// Await the child's completion as a single promise. With spawn, `error`
		// and `close` are mutually exclusive (an `error` means no process ever
		// ran, so no `close` follows) → this resolves exactly once. Phase 2 / B5:
		// this replaces the old `new Promise(async …)` antipattern whose `finish()`
		// helper could double-fire from both handlers.
		const completion = new Promise<{ exitCode: number; stderr: string; text: string }>(
			(resolveDone, rejectDone) => {
				let buf = "";
				let stderr = "";
				let lastText = "";
				const handle = (line: string) => {
					if (!line.trim()) return;
					let ev: any;
					try {
						ev = JSON.parse(line);
					} catch {
						return;
					}
					// Forward every parsed event to the live observer (progress logging).
					opts.onEvent?.(ev);
					if (ev.type === "message_end" && ev.message?.role === "assistant") {
						for (const part of ev.message.content ?? [])
							if (part.type === "text" && part.text) lastText = part.text;
					}
				};
				proc.stdout.on("data", (d) => {
					buf += d.toString();
					const lines = buf.split("\n");
					buf = lines.pop() ?? "";
					for (const l of lines) handle(l);
				});
				proc.stderr.on("data", (d) => {
					stderr += d.toString();
				});
				proc.on("close", (c) => {
					if (buf.trim()) handle(buf);
					resolveDone({ exitCode: c ?? 0, stderr, text: lastText });
				});
				proc.on("error", (e) => rejectDone(e));
			},
		);

		// AbortSignal: SIGTERM → 5s grace → SIGKILL.
		if (signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
		// A3.1: default 5min timeout (OB_SUBAGENT_TIMEOUT_MS). SIGTERM → 5s grace → SIGKILL.
		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				timedOut = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			}, timeoutMs);
		}

		let outcome: { exitCode: number; stderr: string; text: string };
		try {
			outcome = await completion;
		} catch (e: any) {
			// spawn error (e.g. ENOENT — `pi` not on PATH). Single return path —
			// surface as exit 1 instead of leaking an unhandled rejection.
			const msg = e?.message ? String(e.message) : String(e);
			return {
				output: "",
				exitCode: 1,
				stderr: msg,
				timedOut,
				result: null,
			};
		}
		const result = parseStructuredResult(outcome.text);
		return {
			output: outcome.text,
			exitCode: outcome.exitCode,
			stderr: outcome.stderr,
			timedOut,
			result,
		};
	} finally {
		if (timer) clearTimeout(timer);
		if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
}

// ---- Vault gardener subagent ---------------------------------------------

/** System prompt for the vault gardener: audits & repairs knowledge-base health. */
export const GARDEN_SYSTEM_PROMPT = `你是一名 Obsidian vault 圖丁（gardener），負責維護知識庫的健康度。你會掃描整個 vault，找出品質問題，依模式決定只回報或實際修復。

## 健康度檢查項（逐一執行）
用 obsidian 工具（action:"list"）列出所有筆記，用 obsidian 工具（action:"read"）讀內容，用 obsidian 工具（action:"search"）驗證連結，檢查：

每個發現都標註嚴重等級，回報與 JSON 都要帶：🔴 critical（結構損壞，必須處理）、🟡 warning（明確的健康問題）、🟢 info（改善機會，非錯誤）。

1. 🔴 **破損 wiki-link**：[[Target]] 指向不存在的筆記。
2. 🔴 **缺漏 / 損壞 frontmatter**：Zettelkasten/ 下的筆記應有 id / created / tags / sources 欄位；缺任一者、或 YAML 無法解析即回報。
3. 🟡 **孤兒卡（Orphan）**：沒有任何其他筆記用 wiki-link 指向它的筆記（Zettelkasten 筆記尤其不能孤兒）。對每張可疑卡，用 obsidian 工具（action:"search"）搜尋它的標題確認是否真無入連結。
4. 🟡 **疑似重複**：兩張以上筆記談論幾乎相同的論點。
5. 🟡 **MOC 漂移**：Tags/Index.md 缺少某些既存 tag 的段落，或某 tag 段落漏列了帶該 tag 的筆記。
6. 🟢 **漏連的相關筆記**：兩張筆記語義高度相關卻未互相 wiki-link——這是提升圖譜密度的高價值機會。

### 疑似重複的結構化前置篩選（避免對所有筆記兩兩比對）
不要直接對整個 vault 做語義兩兩比較（O(n²)、昂貴且不可重現）。先縮小候選集，只對候選集做語義判斷：
- 用 obsidian 工具（action:"search"）/ 索引找出 **共享 ≥2 個 tag** 的筆記群。
- 在同一群內，再挑**標題詞彙重疊**者（用 obsidian 工具（action:"search"）以標題中的關鍵詞查詢）。
- 只對這個候選短名單做語義判斷（是否談論幾乎相同的論點）。語義判斷要看主張內容，不是只看檔名或 tag 相同。

## 模式
- **audit（預設）**：只做檢查，不改動任何檔案。輸出一份結構化健康報告。
- **fix**：做完檢查後，對「安全且明確」的項目執行修復。**不確定就不改**。修復限於：
  - 為孤兒卡補上語義相關的 wiki-link（用 obsidian 工具（action:"append_section"）加到「## 連結」段落）。
  - 為漏連的相關筆記對補雙向連結。
  - 把缺漏的筆記補進 Tags/Index.md 對應 tag 段落（用 obsidian 工具的 append_section action）。
  - **不要**刪除或合併筆記，不要修改 frontmatter 的 id。疑似重複只回報，不自動合併。

## 輸出格式（繁體中文）
### 健康報告
為每個檢查項給一段：項目名、發現數量、逐條列出（每條標註嚴重等級 🔴/🟡/🟢 + 檔名 + 一句話問題描述）。
最後給「## 總結」：整體健康評分（1-5 ★）、最嚴重的 3 個問題、建議優先處理順序。

若為 fix 模式，在報告前加「### 已執行修復」段落，逐條列實際改了什麼（哪個檔案、加了什麼連結／更新了哪段）。

## 規則
- 只用提供的工具。fix 模式下只能用 obsidian 工具（action:"append_section"）/ obsidian 工具（action:"create"），不可刪檔。
- 所有路徑相對於 vault 根。
- 簡潔但完整。

## 完成後（重要）
報告完成後，**最後一行必須是一條結構化 JSON**（供父代理解析），格式如下，獨占一行，不要用 markdown 包裹：

    {"type":"pi_obsidian_result","notesCreated":<數字>,"linksAdded":<數字>,"notesModified":["fix 模式實際改動過的筆記檔名"],"issuesFound":<數字>,"issues":[{"kind":"orphan|dead-link|duplicate|missing-frontmatter|moc-drift","path":"檔名","severity":"critical|warning|info","detail":"一句話"}],"errors":["若有的話"]}

這條 JSON 是給程式讀的。數字字段若不適用填 0；audit 模式 notesModified 為空陣列。`;

// ---- Subagent output validation (Phase 2 / WS-B1) -------------------------
// distill/garden subagents write to the vault via obsidian_create inside the
// child process; the parent only sees the assistant's final text + the
// trailing `pi_obsidian_result` JSON (which lists created note paths). We can't
// intercept writes that happen in the child, so B1 is a POST-RUN audit: read
// every note the subagent claims to have created and validate it (frontmatter
// schema, valid YAML, sane size, wiki-link targets resolve). Malformed output
// is then REPORTED (and surfaced in the tool result) instead of silently
// corrupting the vault — the caller can review/repair/delete the bad notes.

/** Sane upper bound for a single Zettelkasten card. A subagent emitting a
 *  >64KB blob is almost certainly garbage / a prompt-injection dump. */
export const ZETTEL_MAX_BYTES = 64 * 1024;
/** Required frontmatter keys for a Zettelkasten card (per ZETTEL_SYSTEM_PROMPT). */
export const ZETTEL_REQUIRED_KEYS = ["id", "created", "tags", "sources"];

export interface NoteValidation {
	path: string;
	ok: boolean;
	errors: string[];
}

/** Validate a single note's content against the Zettelkasten card schema.
 *  Pure (no I/O) — unit-tested directly. When `idx` is provided, wiki-link
 *  targets are also checked for resolvability (dead links flagged). */
export function validateZettelNote(
	content: string | undefined,
	idx?: VaultIndex,
): { ok: boolean; errors: string[] } {
	const errors: string[] = [];
	if (!content || !content.trim()) return { ok: false, errors: ["empty content"] };
	if (Buffer.byteLength(content, "utf8") > ZETTEL_MAX_BYTES)
		errors.push(`note exceeds ${ZETTEL_MAX_BYTES / 1024}KB (likely garbage)`);
	// Frontmatter presence: leading `---` ... `---`.
	const lines = content.split("\n");
	const hasFm = lines.length > 0 && lines[0]!.trim() === "---" && lines.slice(1).some((l) => l.trim() === "---");
	if (!hasFm) {
		errors.push("missing YAML frontmatter (no leading `---` block)");
	} else {
		const { data } = parseFrontmatter(content);
		for (const k of ZETTEL_REQUIRED_KEYS)
			if (!(k in data) || data[k] === "" || data[k] == null)
				errors.push(`frontmatter missing required key: ${k}`);
		if (Array.isArray(data.tags) && data.tags.length > 0) {
			if (String(data.tags[0]).toLowerCase() !== "zettel")
				errors.push(`tags[0] should be "zettel" (got ${JSON.stringify(data.tags[0])})`);
		} else if (data.tags !== undefined) {
			errors.push("frontmatter `tags` must be a non-empty array");
		}
	}
	// Wiki-link target resolvability (only when an index is available).
	if (idx) {
		const dead = new Set<string>();
		for (const line of lines)
			for (const link of extractWikiLinks(line)) {
				if (!resolveLink(idx, link)) dead.add(link);
			}
		if (dead.size > 0)
			errors.push(`${dead.size} unresolved wiki-link target(s): ${[...dead].slice(0, 5).map((l) => `[[${l}]]`).join(", ")}${dead.size > 5 ? " …" : ""}`);
	}
	return { ok: errors.length === 0, errors };
}

/** Audit every note path a subagent reported creating. Returns a per-note
 *  validation report plus an aggregate. Notes that don't exist on disk (the
 *  subagent lied or the write raced) are flagged, not crashed on. */
export async function validateZettelNotes(
	vaultPath: string,
	paths: string[],
): Promise<{ notes: NoteValidation[]; valid: number; invalid: number }> {
	if (!paths || paths.length === 0)
		return { notes: [], valid: 0, invalid: 0 };
	let idx: VaultIndex | undefined;
	try {
		idx = await getIndex(vaultPath);
	} catch {
		idx = undefined;
	}
	const notes: NoteValidation[] = [];
	for (const rel of paths) {
		const abs = safeNotePath(vaultPath, rel);
		const cached = await readCached(abs);
		if (!cached) {
			notes.push({ path: rel, ok: false, errors: ["note not found on disk (subagent reported it but it's missing)"] });
			continue;
		}
		const { ok, errors } = validateZettelNote(cached.content, idx);
		notes.push({ path: rel, ok, errors });
	}
	return {
		notes,
		valid: notes.filter((n) => n.ok).length,
		invalid: notes.filter((n) => !n.ok).length,
	};
}

// ---- Note integrity check (Phase 5 / WS-B4) -------------------------------
// Lighter than validateZettelNote: garden edits ARBITRARY notes (not only
// Zettel cards), so the strict tags[0]==="zettel" rule does NOT apply. This
// only checks the markdown is still structurally sound after a fix-mode run —
// frontmatter (if present) is balanced, the note is non-empty, and code fences
// are paired. Pure (no I/O); unit-tested directly.

export interface IntegrityIssue {
	path: string;
	ok: boolean;
	errors: string[];
}

/** Validate a note's structural integrity. Pure (no I/O). */
export function validateNoteIntegrity(
	content: string | undefined,
): { ok: boolean; errors: string[] } {
	const errors: string[] = [];
	if (!content || !content.trim())
		return { ok: false, errors: ["empty content"] };
	const lines = content.split("\n");
	// Frontmatter: a leading `---` MUST be closed by a second `---`. An
	// unbalanced opener means the body got accidentally merged into YAML.
	if (lines[0]!.trim() === "---") {
		const closed = lines.slice(1).some((l) => l.trim() === "---");
		if (!closed) errors.push("frontmatter opened with --- but never closed");
	}
	// Code-fence balance: an odd count of ``` / ~~~ openers means a fence was
	// opened but never closed (or vice-versa) — a common append_section accident.
	const fence3 = lines.filter((l) => /^```/.test(l.trim())).length;
	const fence4 = lines.filter((l) => /^~~~/.test(l.trim())).length;
	if (fence3 % 2 !== 0) errors.push(`unbalanced \`\`\` code fences (${fence3} opener(s))`);
	if (fence4 % 2 !== 0) errors.push(`unbalanced ~~~ code fences (${fence4} opener(s))`);
	return { ok: errors.length === 0, errors };
}

/** Audit every note path a fix-mode garden run reported modifying. Reads each
 *  from disk (via the cache) and runs validateNoteIntegrity. Best-effort:
 *  missing-on-disk notes are flagged, never thrown on. */
export async function validateNoteIntegrityBatch(
	vaultPath: string,
	paths: string[],
): Promise<{ notes: IntegrityIssue[]; intact: number; broken: number }> {
	const notes: IntegrityIssue[] = [];
	for (const rel of paths) {
		const abs = safeNotePath(vaultPath, rel);
		const cached = await readCached(abs);
		if (!cached) {
			notes.push({ path: rel, ok: false, errors: ["note not found on disk (reported as modified but missing)"] });
			continue;
		}
		const { ok, errors } = validateNoteIntegrity(cached.content);
		notes.push({ path: rel, ok, errors });
	}
	return {
		notes,
		intact: notes.filter((n) => n.ok).length,
		broken: notes.filter((n) => !n.ok).length,
	};
}

/**
 * Schedule the transient "obsidian vault active" banner: show once after a
 * short delay, then auto-dismiss. Both deferred ctx.ui calls are guarded — a
 * session switch (/resume, ctx.fork, ctx.switchSession) between schedule and
 * fire leaves ctx stale, and ctx.ui's assertActive() would otherwise throw an
 * uncaughtException that crashes pi. Extracted from the session_start handler
 * so the guard is unit-testable (see __tests__/banner-stale-ctx.test.mjs).
 */
export function scheduleVaultBanner(
	ctx: { ui: { setWidget(key: string, lines: string[] | undefined): void } },
	line: string,
): void {
	const SHOW_DELAY_MS = 10_000; // past the startup notify burst (zai-mcp)
	const DISPLAY_MS = 8_000; // visible window before auto-dismiss
	setTimeout(() => {
		try {
			ctx.ui.setWidget("obsidian-vault", [line]);
		} catch {
			/* ctx stale after session switch — banner is non-essential */
			return;
		}
		// Auto-dismiss after DISPLAY_MS. Guarded the same way: a session
		// switch between show and dismiss leaves ctx stale.
		setTimeout(() => {
			try {
				ctx.ui.setWidget("obsidian-vault", undefined);
			} catch {
				/* ctx stale after session switch */
			}
		}, DISPLAY_MS);
	}, SHOW_DELAY_MS);
}

// ─── obsidian_search on-demand reference (single source) ───────────────────
// The full per-enum/per-field semantics for `obsidian_search`. The always-on
// tool description + the enum/param descriptions are kept TERSE (value lists +
// a pointer here); this prose lives behind `obsidian_search_help`, which calls
// these same consts — so the two surfaces cannot drift. Mirrors the flux2/ltx
// on-demand-help split (−73% schema cost on those tools).
//
// Retrieval-neutral by construction: only description STRINGS change. Param
// names, types, enum literal values, the required set, and the dispatcher
// execute() logic are byte-identical → search/graph results are unchanged.

/** Terse always-on routing description for obsidian_search (routing info only). */
export function searchRoutingDescription(): string {
	return (
		"Full-text search across notes (substring/regex/words/fuzzy) + graph queries " +
		"(backlinks/outgoing/orphans/dead-links/neighbors); returns file:line snippets. " +
		"Per-mode semantics → obsidian_search_help."
	);
}

/** The full per-enum/per-field reference (the prose the old description embedded).
 *  Returned verbatim by obsidian_search_help so no capability is lost. */
export function searchReferenceText(): string {
	return [
		"── obsidian_search reference ──",
		"",
		"matchMode (what `query` means):",
		"  • substring (default) — literal substring.",
		"  • regex — JS RegExp (new RegExp(query, flags)).",
		"  • words — tokens AND; `|`=OR group, `-token`=NOT (file-level: excludes any",
		"    file where the term appears anywhere); tokens within a group are AND.",
		"  • fuzzy — typo-tolerant (tolerance scales with length: ≤3 chars → 0, ≤6 → 1, else 2).",
		"",
		"fields (restrict searchable note sections):",
		"  • all (default) — everywhere.",
		"  • title — first H1.",
		"  • tags — frontmatter `tags:`/`tag:` line + inline `#tag` lines.",
		"  • frontmatter — the `---` block.",
		"  • body — the rest.",
		"",
		"sort (result ordering):",
		"  • file (default) — alphabetical traversal.",
		"  • relevance — title +10 / tag +6 / frontmatter +3 / body +1, summed per file.",
		"  • recency — frontmatter created date desc.",
		"",
		"graph (overrides matchMode/fields; query is a note title unless noted):",
		"  • backlinks — notes that wiki-link to `query` ([[query]]); normalizes away .md,",
		"    case-insensitive unless caseSensitive. The `backlinks:true` param is a legacy alias.",
		"  • outgoing — what `query` links to.",
		"  • orphans — notes with no inbound links.",
		"  • dead-links — [[Target]] pointing to nonexistent notes.",
		"  • neighbors — N-hop neighborhood of `query` (`depth`, default 1).",
		"",
		"Output shaping:",
		"  • context — lines of surrounding context per match (0 = single line, the default).",
		"    When >0 the text field shows an indented snippet with the hit line marked `>`.",
		"  • groupByFile — collapse to at most `perFile` matches per file (default false).",
		"  • perFile — max matches per file when groupByFile (default 3).",
		"  • max — hard cap on total returned matches (default 50).",
		"  • folder — restrict to a sub-tree relative to vault root (default: whole vault).",
		"  • caseSensitive — default false. Also applies to backlink matching (link targets",
		"    are matched case-insensitively by default).",
		"  • paths — restrict matching to this set of vault-relative paths (e.g. from",
		"    obsidian_query). Ignores `folder`.",
		"",
		"Other: a `#`-prefixed query is a tag search. regex mode auto-repairs over-escaped",
		"alternations (e.g. `SEARCH\\(WORD\\|TERM\\)` → `SEARCH(WORD|TERM)`) on a 0-match result.",
	].join("\n");
}

/** Terse routing description for the fat obsidian tool (~120 tok).
 *  Heavy per-action semantics → obsidian_help. */
export function obsidianRoutingDescription(): string {
	return (
		"Vault I/O + search + knowledge workflows. One tool with an `action` parameter " +
		"selecting the operation (list/read/create/append/append_section/search/" +
		"semantic_search/query/move/rename/update_frontmatter/delete/invalidate/open/" +
		"distill/garden/status). All other parameters are action-specific. " +
		"Per-action details → obsidian_help."
	);
}

/** Full per-action reference text (the prose the old fat-tool description embedded).
 *  Returned verbatim by obsidian_help so no capability is lost. Reads the SAME
 *  action list as the dispatcher — single-sourced, no drift. */
export function obsidianActionReferenceText(): string {
	return [
		"── obsidian actions reference ──",
		"",
		"list (notes under folder)",
		"  Params: folder? — vault-relative folder path. Omit for root.",
		"  Returns: paths relative to vault root.",
		"",
		"read (note content)",
		"  Params: note (required) — vault-relative path, with or without .md.",
		"",
		"create (new note)",
		"  Params: note (required), content (required), overwrite?, expectedMtime?.",
		"  Parent folders auto-created. Refuses overwrite unless overwrite:true or expectedMtime set.",
		"",
		"append (text to note)",
		"  Params: note (required), content (required), expectedMtime?.",
		"  Creates note if missing. Adds blank-line separator before appended text.",
		"",
		"append_section (under heading)",
		"  Params: note (required), heading (required, without # marks), content (required), expectedMtime?.",
		"  Matches any heading level. Creates heading at end if missing.",
		"",
		"search (full-text + graph)",
		"  Params: query (required), matchMode?, caseSensitive?, folder?, fields?, context?,",
		"  sort?, groupByFile?, perFile?, max?, paths?, graph?, depth?, backlinks?.",
		"  Full-text (substring/regex/words/fuzzy) + graph queries (backlinks/outgoing/orphans/",
		"  dead-links/neighbors). Returns file:line snippets. #-prefixed query = tag search.",
		"  Per-mode semantics → obsidian_search_help.",
		"",
		"semantic_search (vector similarity)",
		"  Params: query (required), vault_name?, limit?, similarity_threshold?,",
		"  include_tags?, exclude_tags?.",
		"  Meaning-based retrieval via vault-mind ChromaDB. Gracefully errors if unreachable.",
		"",
		"query (metadata/tags/dates)",
		"  Params: tags?, anyTags?, folder?, createdAfter?, createdBefore?, max?.",
		"  Index-only metadata query (Dataview-lite). Does NOT read note bodies.",
		"",
		"move (rename+rewrite links)",
		"  Params: from (required), to (required), overwrite?.",
		"  Moves note and rewrites ALL inbound [[wiki-links]] across the vault.",
		"",
		"rename (same dir)",
		"  Params: note (required), newName (required).",
		"  Renames in place; rewrites inbound links.",
		"",
		"update_frontmatter (merge keys)",
		"  Params: note (required), patch (required, key→value object), expectedMtime?.",
		"  tags is unioned (additive); other keys set/replace. Body untouched.",
		"",
		"delete (remove+cleanup links)",
		"  Params: note (required), confirm (required, must be true), cleanupLinks? (default true).",
		"  Deletes note and strips all [[wiki-links]] pointing to it. Safety guard requires confirm:true.",
		"",
		"invalidate (reconcile cache)",
		"  Params: path? — vault-relative note/folder to reconcile; omit for whole vault.",
		"  Reconciles read cache/index after external edits.",
		"",
		"open (launch in app)",
		"  Params: note? — vault-relative path. Omit to open the vault in Obsidian.",
		"",
		"distill (files→Zettelkasten notes)",
		"  Params: files (required, array of paths), folder? (default Zettelkasten), maxNotes?.",
		"  Spawns an isolated subagent that decomposes files into atomic Zettelkasten notes.",
		"",
		"garden (audit/repair graph health)",
		"  Params: engine? (deterministic|llm, default deterministic), mode? (audit|fix, default audit),",
		"  scope? (vault folder, default whole vault), fix? (alias for mode:fix).",
		"  deterministic = fast library scan of convergence folder; llm = full-vault subagent audit.",
		"",
		"status (show active vault)",
		"  No params. Shows resolved vault path/name/source/note-count + all candidates.",
	].join("\n");
}

// ---- Deterministic health check registration (Phase 1 de-dup) ------------
// The deterministic graph health check (graphHealth/healGraph) lives in
// pi-agent-ext-knowledge-card/src/retrieve.ts. To avoid a backwards import
// dependency (obsidian → knowledge-card), knowledge-card registers its
// implementation here at extension load time. The garden tool's deterministic
// engine calls through this indirection.

export interface DetHealthResult {
	health: any;
	text: string;
}

let _detHealthFn: ((opts: {
	vaultPath: string;
	folder: string;
	mocPath: string;
	fix: boolean;
}) => Promise<DetHealthResult>) | null = null;

export function registerDeterministicHealthCheck(
	fn: (opts: {
		vaultPath: string;
		folder: string;
		mocPath: string;
		fix: boolean;
	}) => Promise<DetHealthResult>,
) {
	_detHealthFn = fn;
}

export async function runDeterministicHealthCheck(opts: {
	vaultPath: string;
	folder: string;
	mocPath: string;
	fix: boolean;
}): Promise<DetHealthResult> {
	if (!_detHealthFn) {
		throw new Error(
			"Deterministic health check not available — pi-agent-ext-knowledge-card not loaded",
		);
	}
	return _detHealthFn(opts);
}
// ---- Zettel frontmatter auto-repair (distill backstop) --------------------
// When the distill subagent omits a required key that can be computed
// deterministically, fill it instead of leaving the note malformed. Only fills
// ABSENT keys — never overwrites an existing value or reorders tags (a
// wrong-but-present tags[0] stays a reported warning, not a silent mutation).

/** Format an epoch-ms mtime into the Zettel `id` (YYYYMMDDHHmm, local) and
 *  `created` (YYYY-MM-DD, local) formats mandated by ZETTEL_SYSTEM_PROMPT. */
export function mtimeToZettelIds(mtimeMs: number): { id: string; created: string } {
	const d = new Date(mtimeMs);
	const p = (n: number) => String(n).padStart(2, "0");
	return {
		id: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`,
		created: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
	};
}

export interface FrontmatterRepair {
	path: string;
	repaired: string[]; // keys that were filled this run
	skipped: string[]; // required keys already present (left untouched)
	error?: string; // read/write failure reason, if any
}

/** Deterministically fill ABSENT required frontmatter keys on Zettel cards.
 *  Writes back via updateFrontmatter (preserves body, honors optimistic
 *  concurrency). Best-effort — never throws; a failed note is reported, not
 *  fatal. Returns a per-note repair report + total keys filled.
 *
 *  id      ← file mtime as YYYYMMDDHHmm
 *  created ← file mtime as YYYY-MM-DD
 *  tags    ← ["zettel"] (only if absent/empty — never reordered)
 *  sources ← defaultSources (only if absent) */
export async function repairZettelFrontmatter(
	vaultPath: string,
	paths: string[],
	defaultSources: string[],
): Promise<{ notes: FrontmatterRepair[]; totalRepaired: number }> {
	const real = resolve(vaultPath);
	const notes: FrontmatterRepair[] = [];
	let totalRepaired = 0;
	for (const rel of paths) {
		const abs = safeNotePath(real, rel);
		const repaired: string[] = [];
		const skipped: string[] = [];
		try {
			const entry = await readCached(abs);
			if (!entry) {
				notes.push({ path: rel, repaired, skipped, error: "note not found on disk" });
				continue;
			}
			const { data } = parseFrontmatter(entry.content);
			const patch: Record<string, any> = {};
			const has = (k: string) =>
				k in data && data[k] !== "" && data[k] != null &&
				(Array.isArray(data[k]) ? (data[k] as any[]).length > 0 : true);
			// id / created ← file mtime
			if (!has("id") || !has("created")) {
				const ids = mtimeToZettelIds(entry.mtime);
				if (!has("id")) patch.id = ids.id;
				if (!has("created")) patch.created = ids.created;
			}
			// tags ← ["zettel"] only if absent/empty (never reorder existing)
			const tagsArr = Array.isArray(data.tags) ? (data.tags as any[]) : null;
			if (!tagsArr || tagsArr.length === 0) patch.tags = ["zettel"];
			// sources ← defaultSources only if absent
			if (!has("sources") && defaultSources.length > 0) patch.sources = defaultSources;
			for (const k of ZETTEL_REQUIRED_KEYS) if (!(k in patch)) skipped.push(k);
			if (Object.keys(patch).length > 0) {
				await updateFrontmatter(real, rel, patch, { expectedMtime: entry.mtime });
				for (const k of Object.keys(patch)) repaired.push(k);
				totalRepaired += repaired.length;
			}
		} catch (e: any) {
			notes.push({ path: rel, repaired, skipped, error: String(e?.message ?? e) });
			continue;
		}
		notes.push({ path: rel, repaired, skipped });
	}
	return { notes, totalRepaired };
}
