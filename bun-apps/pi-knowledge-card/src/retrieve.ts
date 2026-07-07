/**
 * src/retrieve.ts — deterministic knowledge-graph READ side (symmetric to
 * ingest.ts's WRITE side).
 *
 * ingest.ts converges structured records INTO the shared vault folder as
 * cross-linked zettel cards. retrieve.ts reads them BACK OUT for cross-
 * workflow injection: a self-improve loop at Resolve asks "what did OTHER
 * workflows learn that is relevant to my tag space?" and gets a compact
 * digest of cards it does NOT already own.
 *
 * Three primitives (all deterministic — no LLM, no network):
 *
 *   readActiveIds(kbFile)        — parse a workflow's .knowledge.jsonl,
 *                                  return the active record ids (the caller's
 *                                  OWN ids, used to exclude self-cards).
 *
 *   retrieveRecords(opts)        — scan the convergence folder, match ANY of
 *                                  the given tags, rank by shared-tag count,
 *                                  EXCLUDE the caller's own ids, return topK
 *                                  cards with a compact digest.
 *
 *   graphHealth(opts)            — dead-link / MOC-drift / orphan audit scoped
 *                                  to the convergence folder (uses the
 *                                  pi-obsidian VaultIndex substrate).
 *
 *   healGraph(opts)              — auto-heal: regenerate the MOC from on-disk
 *                                  cards + prune dead [[...]] links in-card.
 *                                  Scoped to the convergence folder; NEVER
 *                                  touches human-authored cards outside it.
 *
 * Library only — no ExtensionAPI, no LLM, no network. The zk-query CLI
 * (pi-agent-cli) is a thin shell over these functions.
 *
 * Env (passed through from pi-obsidian): OB_VAULT_PATH / OB_VAULT_DIR.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, getIndex, graphDeadLinks, graphOrphans, invalidateCache } from "pi-obsidian/extensions/obsidian.ts";
import {
	slugify,
	normTag,
	readCardMeta,
	writeMoc,
	extractFeatures,
	type KnowledgeRecord,
} from "./ingest.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetrievedCard {
	/** Canonical record id (the source_id from frontmatter). */
	id: string;
	/** Card title (first H1). */
	title: string;
	/** Record type (lever / avoid / gotcha / pattern / metric / false_positive). */
	type: string;
	/** Detail body (truncated for digest). */
	detail: string;
	/** Tags (normalised). */
	tags: string[];
	/** Shared-tag count with the query (the ranking score before the callout boost). */
	sharedTags: number;
	/** Vault-relative card path. */
	path: string;
	/** Source provenance label. */
	source: string;
	/** True iff the card carries Obsidian callout(s) (P1 feature metadata). */
	hasCallouts: boolean;
	/** First callout headline ("[!warning] ...") — lifted into the digest so the
	 *  highest-signal line is not buried in the truncated prose body. */
	calloutText: string;
}

export interface RetrieveOptions {
	/** Absolute vault path (the convergence sink). */
	vaultPath: string;
	/** Convergence folder inside the vault (default: Zettelkasten/knowledge-graph). */
	folder?: string;
	/** Tags to match (ANY-tag semantics). Normalised internally. */
	tags: string[];
	/** Record ids to EXCLUDE (the caller's own active ids). */
	excludeIds?: string[];
	/** Max cards to return (default 10). */
	topK?: number;
	/** Max detail chars in the returned card (default 240). */
	maxDetailChars?: number;
}

export interface RetrieveResult {
	count: number;
	cards: RetrievedCard[];
	digest: string;
	folder: string;
	scanned: number;
	excluded: number;
}

export interface GraphHealthOptions {
	vaultPath: string;
	folder?: string;
	mocPath?: string;
}

export interface GraphHealthResult {
	ok: boolean;
	vaultPath: string;
	folder: string;
	mocPath: string;
	cardCount: number;
	deadLinks: { source: string; target: string }[];
	mocMissing: boolean;
	mocStale: boolean;
	orphans: string[];
}

export interface HealResult {
	mocRegenerated: boolean;
	deadLinksPruned: number;
	linksDeduped: number;
	cardsTouched: string[];
}

// ---------------------------------------------------------------------------
// readActiveIds — the caller's OWN active record ids
// ---------------------------------------------------------------------------

/**
 * Parse a workflow's `.knowledge.jsonl` and return the ids of records whose
 * status === "active". These are the caller's own cards — retrieveRecords
 * excludes them so the digest is genuinely cross-workflow.
 *
 * Returns [] if the file does not exist or is empty (a new/clean workflow).
 */
export function readActiveIds(kbFile: string): string[] {
	if (!existsSync(kbFile)) return [];
	const ids: string[] = [];
	for (const line of readFileSync(kbFile, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const rec = JSON.parse(trimmed) as KnowledgeRecord;
			if (rec && typeof rec.id === "string" && rec.status === "active") {
				ids.push(rec.id);
			}
		} catch {
			// malformed line — skip
		}
	}
	return ids;
}

// ---------------------------------------------------------------------------
// retrieveRecords — cross-workflow tag-ranked retrieval
// ---------------------------------------------------------------------------

/**
 * Scan the convergence folder for cards matching ANY of `opts.tags`, rank by
 * shared-tag count, exclude `opts.excludeIds` (the caller's own cards), and
 * return the topK as a compact digest.
 *
 * Symmetric to ingestRecords: where ingestRecords WRITES cards and computes
 * cross-link neighbours by shared tags, retrieveRecords READS them back and
 * ranks by the same shared-tag signal — so the retrieval ranking is consistent
 * with the graph's own edge weights.
 */
export async function retrieveRecords(opts: RetrieveOptions): Promise<RetrieveResult> {
	const folder = opts.folder ?? "Zettelkasten/knowledge-graph";
	const topK = opts.topK ?? 10;
	const maxDetailChars = opts.maxDetailChars ?? 240;
	const folderAbs = join(opts.vaultPath, folder);
	const queryTags = new Set(opts.tags.map(normTag).filter(Boolean));
	const excludeIds = new Set((opts.excludeIds ?? []).map((id) => id));
	const excludeSlugs = new Set([...excludeIds].map((id) => slugify(id)));

	if (!existsSync(folderAbs)) {
		return { count: 0, cards: [], digest: "", folder, scanned: 0, excluded: 0 };
	}

	const scored: (RetrievedCard & { _score: number })[] = [];
	let scanned = 0;
	let excluded = 0;

	for (const name of readdirSync(folderAbs)) {
		if (!name.endsWith(".md")) continue;
		const abs = join(folderAbs, name);
		const meta = readCardMeta(abs);
		if (!meta) continue;
		scanned++;

		// Exclude the caller's own cards (by source_id or slug match).
		const cardSlug = name.slice(0, -3);
		if (meta.source_id && excludeIds.has(meta.source_id)) {
			excluded++;
			continue;
		}
		if (excludeSlugs.has(cardSlug)) {
			excluded++;
			continue;
		}

		// Shared-tag count (exclude ubiquitous "zettel" tag from scoring).
		let shared = 0;
		for (const t of queryTags) {
			if (meta.tags.has(t)) shared++;
		}
		if (queryTags.has("zettel") && meta.tags.has("zettel")) shared -= 1;
		if (shared <= 0) continue; // no overlap — skip

	// Read the card content for title/detail/type.
		const content = readFileSync(abs, "utf8");
		const { data } = parseFrontmatter(content);
		// Defense-in-depth: never surface retired/superseded cards as live
		// knowledge. Archived cards already live under _archive/ (excluded by
		// the flat readdirSync), but this guard also catches any stale card that
		// was marked retired in-place without being moved.
		const status = typeof data.status === "string" ? data.status.trim() : "active";
		if (status === "retired" || status === "superseded") {
			excluded++;
			continue;
		}
		const title = extractTitle(content);
		const detail = extractDetail(content, maxDetailChars);
		const type = typeof data.record_type === "string" ? data.record_type : "pattern";
		const source = typeof data.source === "string" ? data.source : "unknown";

		// Feature-aware ranking (kg-improvement-plan P1): a callout-bearing card
		// gets a BOUNDED boost of +0.5, applied AFTER shared-tag count and BEFORE
		// the id localeCompare tie-break. Because shared is an integer and the
		// boost is < 1, a callout card ties-then-beats an equal-tag prose card
		// (shared+0.5 > shared) but NEVER displaces a strictly-more-on-tag prose
		// card (shared+0.5 < shared+1). The warning callout is usually the
		// highest-signal line in a human-authored note; ranking it ahead on a
		// tag tie surfaces it earlier without distorting clearly-better matches.
		//
		// BY-DESIGN: this boost lives in retrieveRecords ONLY, not in zk_ask's
		// buildRagTask Step-3 score (0.7×search + 0.3×links). The two read paths
		// use different score signals AND have different access to feature
		// metadata: retrieveRecords is the deterministic library — it reads each
		// card's frontmatter directly (so hasCallouts is available at rank time);
		// zk_ask's score is computed by the agent from obsidian_search results,
		// where frontmatter is NOT available at Step 3 (notes are read via
		// obsidian_read only in Step 4, after ranking). zk_ask instead surfaces
		// callouts via the Step-4 "Feature surfacing" instruction. The split is
		// pinned by the drift-guard test (retrieve.test.ts + pi-knowledge-card.test.ts).
		const calloutBoost = meta.hasCallouts ? 0.5 : 0;
		// Lift the callout headline text into the digest so the highest-signal
		// sentence is not buried in the truncated prose body. calloutTexts[0] is
		// the first callout's headline ("[!warning] ... ").
		let calloutText = "";
		if (meta.hasCallouts) {
			const feats = extractFeatures(content);
			calloutText = feats.calloutTexts[0] ?? "";
		}

		scored.push({
			id: meta.source_id ?? cardSlug,
			title,
			type,
			detail,
			tags: [...meta.tags].filter((t) => t !== "zettel"),
			sharedTags: shared,
			path: `${folder}/${cardSlug}`,
			source,
			hasCallouts: meta.hasCallouts,
			calloutText,
			_score: shared + calloutBoost,
		});
	}

	scored.sort((a, b) => b._score - a._score || a.id.localeCompare(b.id));
	const top = scored.slice(0, topK).map(({ _score, ...rest }) => rest);

	return {
		count: top.length,
		cards: top,
		digest: formatDigest(top, opts.tags),
		folder,
		scanned,
		excluded,
	};
}

/** Build a compact grouped digest (<= ~1500 chars) for injection into a
 *  workflow's Resolve phase. Grouped by type, highest-shared first. */
function formatDigest(cards: RetrievedCard[], queryTags: string[]): string {
	if (cards.length === 0) return "";
	const header = `(graph: ${cards.length} cross-workflow card(s) for tags [${queryTags.join(", ")}])`;
	const groups = new Map<string, RetrievedCard[]>();
	for (const c of cards) {
		const g = c.type || "pattern";
		if (!groups.has(g)) groups.set(g, []);
		groups.get(g)!.push(c);
	}
	const order = ["gotcha", "avoid", "lever", "pattern", "metric", "false_positive"];
	const present = order.filter((g) => groups.has(g)).concat(
		[...groups.keys()].filter((g) => !order.includes(g)).sort(),
	);
	const parts = [header];
	for (const g of present) {
		parts.push(`[${g.toUpperCase()}]`);
		for (const c of groups.get(g)!) {
			// P1 callout surfacing: when a card carries a callout, lift its headline
			// (`[!warning] ...`) ahead of the truncated prose so the highest-signal
			// sentence reaches the RAG context instead of being buried in the body.
			const calloutPrefix = c.calloutText ? `${c.calloutText} — ` : "";
			parts.push(`- ${c.title} — ${calloutPrefix}${c.detail.slice(0, 160)} (${c.source})`);
		}
	}
	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// graphHealth — dead-link / MOC-drift / orphan audit (scoped to folder)
// ---------------------------------------------------------------------------

/**
 * Audit the convergence folder's graph health: dead [[...]] links, MOC drift
 * (on-disk MOC vs freshly-regenerated MOC), and orphans (cards with no
 * inbound or outbound edges within the folder).
 *
 * Uses the pi-obsidian VaultIndex substrate (getIndex) for link resolution.
 * Scoped to `folder` — never reports on cards outside the convergence folder.
 */
export async function graphHealth(opts: GraphHealthOptions): Promise<GraphHealthResult> {
	const folder = opts.folder ?? "Zettelkasten/knowledge-graph";
	const mocPath = opts.mocPath ?? "Tags/Knowledge Graph.md";
	const folderAbs = join(opts.vaultPath, folder);

	const result: GraphHealthResult = {
		ok: true,
		vaultPath: opts.vaultPath,
		folder,
		mocPath,
		cardCount: 0,
		deadLinks: [],
		mocMissing: false,
		mocStale: false,
		orphans: [],
	};

	if (!existsSync(folderAbs)) return result;

	// 1. Card count + folder file set.
	const cardFiles = readdirSync(folderAbs)
		.filter((n) => n.endsWith(".md"))
		.map((n) => `${folder}/${n}`);
	result.cardCount = cardFiles.length;

	// 2. Dead links — use the VaultIndex, scoped to the convergence folder.
	// graphDeadLinks returns { path: sourceNote, text: "[[target]]" }.
	// FILTER: only count targets that look like valid card slugs (alphanumeric +
	// ._-). Prose false-positives (e.g. Python `[[...]]` nested-list notation in
	// card detail bodies) produce targets like "..." that are not valid slugs.
	const idx = await getIndex(opts.vaultPath);
	const dead = graphDeadLinks(idx);
	for (const d of dead) {
		if (d.path.startsWith(`${folder}/`)) {
			const target = d.text.replace(/^\[\[/, "").replace(/\]\]$/, "");
			if (isValidSlug(target)) {
				result.deadLinks.push({ source: d.path, target });
			}
		}
	}

	// 3. MOC drift — compare on-disk MOC content to a freshly-generated one.
	const mocAbs = join(opts.vaultPath, mocPath);
	if (!existsSync(mocAbs)) {
		result.mocMissing = true;
	} else {
		const onDisk = readFileSync(mocAbs, "utf8");
		// Build the expected MOC content into a temp buffer (dryRun-style).
		const expected = buildMocContent(opts.vaultPath, folder, cardFiles.map((f) => join(opts.vaultPath, f)));
		if (normalizeMoc(onDisk) !== normalizeMoc(expected)) {
			result.mocStale = true;
		}
	}

	// 4. Orphans — notes with no inbound links (graphOrphans), scoped to folder.
	const allOrphans = graphOrphans(idx);
	result.orphans = allOrphans
		.map((o) => o.path)
		.filter((p) => p.startsWith(`${folder}/`))
		.sort();

	// ok = no dead links AND MOC exists AND MOC not stale (orphans are non-fatal).
	result.ok = result.deadLinks.length === 0 && !result.mocMissing && !result.mocStale;
	return result;
}

// ---------------------------------------------------------------------------
// healGraph — auto-heal: regenerate MOC + prune dead links
// ---------------------------------------------------------------------------

/**
 * Auto-heal the convergence folder's graph:
 *   1. Regenerate the MOC from on-disk cards (fixes MOC drift / missing MOC).
 *   2. Prune dead [[...]] links in-card (remove links to non-existent targets).
 *
 * Scoped to the convergence folder ONLY — never touches human-authored cards
 * outside it. Returns a report of what changed.
 */
export async function healGraph(opts: GraphHealthOptions): Promise<HealResult> {
	const folder = opts.folder ?? "Zettelkasten/knowledge-graph";
	const mocPath = opts.mocPath ?? "Tags/Knowledge Graph.md";
	const folderAbs = join(opts.vaultPath, folder);
	const result: HealResult = { mocRegenerated: false, deadLinksPruned: 0, linksDeduped: 0, cardsTouched: [] };

	if (!existsSync(folderAbs)) return result;

	// 1. Regenerate MOC.
	const cardAbs = readdirSync(folderAbs)
		.filter((n) => n.endsWith(".md"))
		.map((n) => join(folderAbs, n));
	if (cardAbs.length > 0) {
		writeMoc(opts.vaultPath, mocPath, cardAbs, false);
		result.mocRegenerated = true;
	}

	// 2. Prune dead [[...]] links in-card.
	// graphDeadLinks returns { path: sourceNote, text: "[[target]]" }.
	// SAFETY: only prune targets that are valid slugs AND appear on a canonical
	// link line ("- 相關：[[target]]" or "- [[target]]"). This prevents
	// corrupting PROSE that happens to contain [[...]] (e.g. Python nested-list
	// notation in card detail bodies — the known false-positive class).
	const idx = await getIndex(opts.vaultPath);
	const dead = graphDeadLinks(idx);
	const deadBySource = new Map<string, Set<string>>();
	for (const d of dead) {
		if (!d.path.startsWith(`${folder}/`)) continue;
		const target = d.text.replace(/^\[\[/, "").replace(/\]\]$/, "");
		if (!isValidSlug(target)) continue; // skip prose false-positives
		if (!deadBySource.has(d.path)) deadBySource.set(d.path, new Set());
		deadBySource.get(d.path)!.add(target);
	}

	for (const [srcRel, targets] of deadBySource) {
		const abs = join(opts.vaultPath, srcRel);
		if (!existsSync(abs)) continue;
		let content = readFileSync(abs, "utf8");
		let pruned = 0;
		for (const target of targets) {
			// ONLY remove canonical-format link lines (never inline prose).
			// Matches: "- 相關：[[target]]\n" or "- [[target|alias]]\n"
			const tgt = escapeRegex(target);
			const re = new RegExp(
				"^- [^\\n]*\\[\\[" + tgt + "(?:\\|[^\\]]*)?\\]\\][^\\n]*\\n",
				"gm",
			);
			const before = content;
			content = content.replace(re, "");
			if (content !== before) pruned++;
		}
		if (pruned > 0) {
			writeFileSync(abs, content, "utf8");
			result.deadLinksPruned += pruned;
			result.cardsTouched.push(srcRel);
		}
	}

	// 3. Dedup identical canonical link lines within each card's `## 連結`
	//    section. Older ingest runs (pre pool-dedup fix in ingestRecords) could
	//    emit duplicate `- 相關：[[target]]` lines when re-ingesting a source
	//    whose cards were already on disk; this normalises them in place. Only
	//    touches lines matching the canonical link format inside the section.
	for (const abs of cardAbs) {
		let content: string;
		try {
			content = readFileSync(abs, "utf8");
		} catch {
			continue;
		}
		// Operate only on the `## 連結` section (from the heading to the next
		// `## ` heading, or EOF). Slice boundaries use `indexOf` from after the
		// `## 連結` heading so the heading itself isn't mistaken for the "next"
		// heading.
		const start = content.indexOf("\n## 連結");
		if (start < 0) continue;
		const bodyStart = start + "\n## 連結".length; // index just after heading text
		const nextIdx = content.indexOf("\n## ", bodyStart);
		const sectionEnd = nextIdx < 0 ? content.length : nextIdx;
		const before = content.slice(0, bodyStart);
		const section = content.slice(bodyStart, sectionEnd);
		const tail = content.slice(sectionEnd);
		const seen = new Set<string>();
		const deduped = section
			.split("\n")
			.filter((line) => {
				if (!/^-\s+相關：\[\[([^\]]+)\]\]/.test(line)) return true; // non-link passes through
				if (seen.has(line)) return false; // exact duplicate dropped
				seen.add(line);
				return true;
			})
			.join("\n");
		const next = before + deduped + tail;
		if (next !== content) {
			writeFileSync(abs, next, "utf8");
			result.linksDeduped += content.split("\n").filter((l) => /^-\s+相關：\[\[/.test(l)).length -
				next.split("\n").filter((l) => /^-\s+相關：\[\[/.test(l)).length;
			if (!result.cardsTouched.includes(abs)) result.cardsTouched.push(abs);
		}
	}

	// Invalidate the index cache so the caller's subsequent graphHealth reads
	// fresh state (the pruned cards changed on disk).
	invalidateCache(opts.vaultPath);

	return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the first H1 title from markdown content. */
function extractTitle(content: string): string {
	const m = content.match(/^#\s+(.+?)\s*$/m);
	return m ? m[1]!.trim() : "(untitled)";
}

/** Extract the 核心想法 (core idea) body section, truncated. */
function extractDetail(content: string, maxChars: number): string {
	const m = content.match(/## 核心想法\n([\s\S]*?)(?=\n## )/);
	if (!m) return "";
	const body = m[1]!.trim();
	return body.length > maxChars ? body.slice(0, maxChars) + "…" : body;
}

/** Build the expected MOC content (dryRun — no write) for drift comparison. */
function buildMocContent(vaultPath: string, folder: string, cardsAbs: string[]): string {
	const groups = new Map<string, string[]>();
	for (const abs of cardsAbs) {
		const meta = readCardMeta(abs);
		if (!meta) continue;
		const base = abs.slice(abs.lastIndexOf("/") + 1, -3);
		let type = "other";
		const typeTag = [...meta.tags][1];
		if (typeTag && typeTag !== "zettel") type = typeTag;
		if (!groups.has(type)) groups.set(type, []);
		groups.get(type)!.push(base);
	}
	for (const list of groups.values()) list.sort();

	const order = ["gotcha", "avoid", "lever", "pattern", "metric", "false_positive", "other"];
	const present = order.filter((g) => groups.has(g)).concat(
		[...groups.keys()].filter((g) => !order.includes(g)).sort(),
	);
	const lines: string[] = [
		"---",
		"id: knowledge-graph-moc",
		'created: "auto"',
		"tags: [zettel, moc, knowledge-graph]",
		"---",
		"",
		"# Knowledge Graph — Converged Cards MOC",
		"",
		"> Auto-generated by `zk_ingest`. Do not edit by hand — regenerate with a re-ingest.",
		"> One card per structured knowledge record, dedup'd by canonical id, cross-linked by shared tags.",
		"",
	];
	for (const g of present) {
		lines.push(`## ${g}`);
		lines.push("");
		for (const name of groups.get(g)!) lines.push(`- [[${name}]]`);
		lines.push("");
	}
	return lines.join("\n");
}

/** Normalize MOC content for drift comparison (trim trailing whitespace per line). */
function normalizeMoc(content: string): string {
	return content
		.split("\n")
		.map((l) => l.trimEnd())
		.join("\n")
		.trim();
}

/** Escape special regex chars in a string. */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Check if a wiki-link target looks like a valid card slug (alphanumeric start
 *  + ._- chars). Prose false-positives like "..." or code expressions fail this. */
function isValidSlug(target: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target) && target.length <= 120;
}

/** Human-readable health report for CLI output. */
export function formatHealth(h: GraphHealthResult): string {
	const lines = [
		`vault:   ${h.vaultPath}`,
		`folder:  ${h.folder}/  (${h.cardCount} card(s))`,
		`moc:     ${h.mocPath}`,
		`status:  ${h.ok ? "OK" : "DRIFT"}`,
		`dead-links: ${h.deadLinks.length}`,
		`moc-missing: ${h.mocMissing ? "yes" : "0"}`,
		`moc-stale: ${h.mocStale ? "yes" : "0"}`,
		`orphans: ${h.orphans.length} (reported, non-fatal)`,
	];
	if (h.deadLinks.length > 0) {
		lines.push("", "dead links:");
		for (const d of h.deadLinks.slice(0, 20)) {
			lines.push(`  ${d.source} → ${d.target}`);
		}
		if (h.deadLinks.length > 20) lines.push(`  …(+${h.deadLinks.length - 20} more)`);
	}
	return lines.join("\n");
}
