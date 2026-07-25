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

export * from "./lib/frontmatter";

import { type VaultIndex, getIndex, dropIndex } from "./lib/index";
export * from "./lib/index";

export * from "./lib/search";

import { backlinkPaths } from "./lib/graph";
export * from "./lib/graph";

export * from "./lib/links";

export * from "./lib/subagent";
export * from "./lib/zettel";

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
