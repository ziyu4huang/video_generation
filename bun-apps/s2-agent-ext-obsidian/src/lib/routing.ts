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
