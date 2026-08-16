/** Graph health audit + heal: orphan/island detection, MOC normalization (split from retrieve.ts — hermes-arch-13 wave 3). */
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
 * (pi-agent) is a thin shell over these functions.
 *
 * Env (passed through from pi-obsidian): OB_VAULT_PATH / OB_VAULT_DIR.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getIndex, graphDeadLinks, graphOrphans, invalidateCache } from "@repo/pi-agent-ext-obsidian/extensions/obsidian.ts";
import { writeMoc } from "./ingest.ts";
import { extractFeatures } from "./card-render.ts";
import type { KnowledgeRecord, CoverageReport } from "./types.ts";
import { buildMocContent, cardAnatomy, readCardFrontmatterFields, readCardMeta, slugify, normTag } from "./card-format.ts";
import { computeIdf, scoreOverlap, type LinkWeighting } from "@repo/pi-agent-core-interface";
import {
	cosine,
	blendScore,
	defaultEmbedder,
	embedQuery,
	getCardEmbeddings,
	lmStudioAvailable,
	minMaxNorm,
	SEMANTIC_ALPHA_DEFAULT,
	SEMANTIC_MODEL_DEFAULT,
	type Embedder,
} from "./semantic.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------


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
	/** Coverage dimension (additive, optional). Populated by the caller layer
	 *  (the zk.health host-fn / zk-query CLI), NOT by graphHealth itself — keeps
	 *  this module structural-only with no runtime ingest coupling. The obsidian
	 *  garden health-check opts are a closed contract, so coverage is surfaced
	 *  via the kcard-owned health paths that return this type. */
	coverage?: CoverageReport;
}

export interface HealResult {
	mocRegenerated: boolean;
	deadLinksPruned: number;
	linksDeduped: number;
	cardsTouched: string[];
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
		const expected = buildMocContent(cardFiles.map((f) => join(opts.vaultPath, f)));
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

/** Extract the first H1 title from markdown content (anatomy via cardAnatomy). */
export function extractTitle(content: string): string {
	const title = cardAnatomy(content).title.trim();
	return title || "(untitled)";
}

/** Extract the 核心想法 (core idea) body section, truncated (anatomy via cardAnatomy). */
export function extractDetail(content: string, maxChars: number): string {
	const body = cardAnatomy(content).body.trim();
	return body.length > maxChars ? body.slice(0, maxChars) + "…" : body;
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
