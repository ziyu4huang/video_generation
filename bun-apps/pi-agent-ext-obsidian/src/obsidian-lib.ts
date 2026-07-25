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

import {
	join,
	resolve,
	relative,
} from "node:path";
import {
	readFile,
	mkdir,
	readdir,
	rm,
	stat,
} from "node:fs/promises";

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
} from "./lib/fs-cache";
export * from "./lib/fs-cache";

export * from "./lib/vault-resolution";

import { parseFrontmatter, updateFrontmatter } from "./lib/frontmatter";
export * from "./lib/frontmatter";

import { type VaultIndex, getIndex, resolveLink, dropIndex } from "./lib/index";
export * from "./lib/index";

export * from "./lib/search";

import { backlinkPaths } from "./lib/graph";
export * from "./lib/graph";

import { extractWikiLinks } from "./lib/links";
export * from "./lib/links";

export * from "./lib/subagent";

// Structured error helpers (errMsg, ErrCode, VaultError, fsErrCode,
// classifyFsError, toolError, toolErrorFromCaught) live in ./lib/errors and are
// re-exported via the barrel at the top of this file.

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
