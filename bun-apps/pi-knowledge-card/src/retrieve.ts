/**
 * src/retrieve.ts — deterministic READ side of the unified knowledge graph.
 *
 * `ingest.ts` is the WRITE side (structured records → zettel cards). This module
 * is the symmetric READ side: it drives the same deterministic pi-obsidian
 * substrate (`getIndex`) to retrieve cards relevant to a workflow's scope, so a
 * self-improve loop can learn what EVERY other loop learned — not just what its
 * own colocated `.knowledge.jsonl` carries.
 *
 * Why deterministic (no LLM) here, mirroring zk_ingest's split:
 *  - Resolve-time injection must be cheap + reproducible so the contract lane
 *    stays deterministic. A `zk_ask` LLM call is the right tool for ad-hoc
 *    cross-source Q&A; it is the wrong tool for "inject 8 relevant gotchas into
 *    this run before Review".
 *  - Routing retrieval through an LLM would re-silo the graph (the model picks
 *    what it "thinks" is relevant) and cost GPU/tokens on every run. Tag-overlap
 *    ranking over the index is O(candidates) and byte-identical across runs.
 *
 * ## Closed-loop proof
 *
 * The `excludeIds` / `excludeFromKb` knob is what makes the feedback VISIBLE:
 * pass the calling workflow's own active record ids, and the digest contains
 * ONLY cards from OTHER workflows. A flux2 run that surfaces an `argparse-*` or
 * `correctness-*` card (ids it never wrote) is the proof that the loop reads
 * cross-workflow knowledge, not just its own projection.
 *
 * Library only — no ExtensionAPI, no LLM, no network. The `zk-query` CLI and
 * the `loadGraphKnowledge` workflow helper are thin shells over `retrieveRecords`.
 *
 * Env (passed through from pi-obsidian): OB_VAULT_PATH / OB_VAULT_DIR.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getIndex, parseFrontmatter } from "pi-obsidian/extensions/obsidian.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetrieveOptions {
	/** Absolute vault path (the convergence sink — single shared vault). */
	vaultPath: string;
	/** Tags to match (ANY-tag semantics: a card needs ≥1 of these to qualify).
	 *  Normalised internally — leading `#`, case, and separators are folded. */
	tags: string[];
	/** Record ids to EXCLUDE (the calling workflow's own active ids). Lets the
	 *  digest surface only CROSS-workflow knowledge. */
	excludeIds?: string[];
	/** Skip cards whose frontmatter `source` matches this label exactly. */
	excludeSourceLabel?: string;
	/** Convergence folder (default: Zettelkasten/knowledge-graph). */
	folder?: string;
	/** Max cards to return after ranking (default: 12). */
	topK?: number;
	/** Max detail chars per card in the digest (default: 240). */
	maxDetailChars?: number;
}

export interface RetrievedCard {
	id: string;
	title: string;
	detail: string;
	source: string;
	recordType: string;
	tags: string[];
	path: string; // vault-relative
	sharedTags: string[]; // which query tags overlapped (digest context)
}

export interface RetrieveSummary {
	vaultPath: string;
	folder: string;
	query: { tags: string[]; excludeIds: number; excludeSourceLabel?: string };
	total: number; // cards scanned in folder
	matched: number; // after exclude, before topK
	returned: number; // after topK
	topK: number;
	cards: RetrievedCard[];
}

// ---------------------------------------------------------------------------
// Health (read-side integrity gate)
// ---------------------------------------------------------------------------

export interface GraphHealthOptions {
	vaultPath: string;
	folder?: string;
	mocPath?: string; // default: Tags/Knowledge Graph.md
}

export interface GraphHealthReport {
	vaultPath: string;
	folder: string;
	mocPath: string;
	cardCount: number;
	deadLinks: { from: string; target: string }[]; // [[target]] resolves to no note
	mocMissing: string[]; // cards present in folder but absent from the MOC
	mocStale: string[]; // MOC lists cards absent from the folder
	orphans: string[]; // cards with zero incoming links
	ok: boolean; // true iff deadLinks + mocMissing + mocStale are all empty
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise a tag for matching (lowercase, trim, spaces/dots → -). Mirrors
 *  ingest.ts' normTag so a query for "path-safety" matches the card tag set. */
function normTag(t: string): string {
	return t.trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-");
}

/** Strip a leading H1 + frontmatter, then pull the `## 核心想法` (core idea)
 *  section body — the canonical one-paragraph digest of a card. Returns the
 *  truncated plain text, or "" if the section is absent. */
function extractCardDetail(content: string, maxChars: number): string {
	const lines = content.split("\n");
	let inSection = false;
	let inFrontmatter = false;
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const ln = lines[i]!;
		if (ln.trim() === "---") {
			inFrontmatter = !inFrontmatter;
			continue;
		}
		if (inFrontmatter) continue;
		if (/^##\s+核心想法/.test(ln)) {
			inSection = true;
			continue;
		}
		if (/^##\s+/.test(ln) && inSection) break; // next section ends it
		if (inSection) {
			const t = ln.trim();
			if (t) out.push(t);
		}
	}
	const text = out.join(" ").replace(/\s+/g, " ").trim();
	return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
}

/** Read a card file's frontmatter fields needed for retrieval + exclusion. */
function readCardFrontmatter(absPath: string): {
	id?: string;
	source?: string;
	recordType?: string;
} | null {
	try {
		const { data } = parseFrontmatter(readFileSync(absPath, "utf8"));
		return {
			id: typeof data.id === "string" ? data.id : undefined,
			source: typeof data.source === "string" ? data.source : undefined,
			recordType: typeof data.record_type === "string" ? data.record_type : undefined,
		};
	} catch {
		return null;
	}
}

/** Resolve a vault-relative card path to its note basename (no .md, no folder).
 *  Used for both detail reads and link-target matching. */
function basename(path: string): string {
	const last = path.split("/").pop() ?? path;
	return last.replace(/\.md$/i, "");
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/**
 * Retrieve converged cards from the shared graph relevant to a tag set.
 *
 * Matching: ANY-tag (a card qualifies if it carries ≥1 of `tags`). Cards are
 * ranked by shared-tag count (desc) then title (asc), and truncated to `topK`.
 * The caller's own record ids (`excludeIds`) and/or source label are removed so
 * the returned digest is genuinely CROSS-workflow.
 */
export async function retrieveRecords(
	opts: RetrieveOptions,
): Promise<RetrieveSummary> {
	const folder = opts.folder ?? "Zettelkasten/knowledge-graph";
	const topK = opts.topK ?? 12;
	const maxDetailChars = opts.maxDetailChars ?? 240;
	const queryTags = new Set(opts.tags.map(normTag).filter(Boolean));
	const excludeIds = new Set(opts.excludeIds ?? []);

	const idx = await getIndex(opts.vaultPath);
	const folderPrefix = folder.replace(/\/+$/, "") + "/";

	// Candidate set = notes in the folder carrying ANY query tag. Use byTag for
	// O(tags) lookup, then narrow by folder. If no query tags given, fall back to
	// the whole folder (e.g. a "what's in the graph" browse).
	let candidatePaths = new Set<string>();
	if (queryTags.size > 0) {
		for (const t of queryTags) {
			const hits = idx.byTag.get(t);
			if (hits) for (const p of hits) if (p.startsWith(folderPrefix)) candidatePaths.add(p);
		}
	} else {
		for (const path of idx.notes.keys()) if (path.startsWith(folderPrefix)) candidatePaths.add(path);
	}

	const total = [...idx.notes.keys()].filter((p) => p.startsWith(folderPrefix)).length;
	const cards: RetrievedCard[] = [];

	for (const path of candidatePaths) {
		const meta = idx.notes.get(path);
		if (!meta) continue;
		const abs = join(opts.vaultPath, path);
		const fm = readCardFrontmatter(abs);
		const id = fm?.id ?? basename(path);
		if (excludeIds.has(id)) continue;
		if (opts.excludeSourceLabel && fm?.source === opts.excludeSourceLabel) continue;

		const cardTags = new Set(meta.tags.map(normTag));
		const shared = [...queryTags].filter((t) => cardTags.has(t));
		// ANY-tag already guaranteed via byTag; shared is the ranking overlap.
		cards.push({
			id,
			title: meta.title || basename(path),
			detail: extractCardDetail(readFileSync(abs, "utf8"), maxDetailChars),
			source: fm?.source ?? "",
			recordType: fm?.recordType ?? "",
			tags: meta.tags,
			path,
			sharedTags: shared,
		});
	}

	cards.sort(
		(a, b) => b.sharedTags.length - a.sharedTags.length || a.title.localeCompare(b.title),
	);
	const truncated = cards.slice(0, topK);

	return {
		vaultPath: opts.vaultPath,
		folder,
		query: {
			tags: [...queryTags],
			excludeIds: excludeIds.size,
			excludeSourceLabel: opts.excludeSourceLabel,
		},
		total,
		matched: cards.length,
		returned: truncated.length,
		topK,
		cards: truncated,
	};
}

/** Render a compact, grouped digest for Resolve-time injection (<= ~1500 chars).
 *  Mirrors loadKnowledge's digest shape so the two can be concatenated cleanly. */
export function formatRetrieveDigest(s: RetrieveSummary): string {
	if (s.cards.length === 0) {
		return `(graph: 0 cross-workflow cards for tags [${s.query.tags.join(", ")}] — vault has ${s.total} card(s) in ${s.folder})`;
	}
	const groups = new Map<string, RetrievedCard[]>();
	for (const c of s.cards) {
		const g = c.recordType || "other";
		if (!groups.has(g)) groups.set(g, []);
		groups.get(g)!.push(c);
	}
	const order = ["gotcha", "avoid", "lever", "pattern", "metric", "false_positive", "other"];
	const present = order.filter((g) => groups.has(g)).concat(
		[...groups.keys()].filter((g) => !order.includes(g)).sort(),
	);
	const lines: string[] = [
		`(graph: ${s.returned} cross-workflow card(s) from ${s.folder} for tags [${s.query.tags.join(", ")}])`,
	];
	for (const g of present) {
		lines.push(`[${g.toUpperCase()}]`);
		for (const c of groups.get(g)!) {
			const src = c.source ? ` (${c.source})` : "";
			lines.push(`- ${c.title}${src}`);
			if (c.detail) lines.push(`    ${c.detail}`);
		}
	}
	return lines.join("\n").slice(0, 4000);
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/** Read a `.knowledge.jsonl` file and return the active record ids. Used by the
 *  CLI's `--exclude-from-kb` to skip the caller's own cards without an LLM. */
export function readActiveIds(kbPath: string): string[] {
	if (!existsSync(kbPath)) return [];
	const ids: string[] = [];
	for (const raw of readFileSync(kbPath, "utf8").split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		try {
			const rec = JSON.parse(line) as { id?: string; status?: string };
			if (typeof rec.id === "string" && rec.status !== "superseded" && rec.status !== "retired") {
				ids.push(rec.id);
			}
		} catch {
			/* skip malformed */
		}
	}
	return ids;
}

/**
 * Graph integrity gate: dead links, MOC drift, orphans. Deterministic — runs
 * over the on-disk index + the MOC file. `ok` is true iff there are no dead
 * links and no MOC drift (orphans are reported but do not fail the gate, since
 * a freshly-ingested card has no inbound links until a neighbour lands).
 */
export async function graphHealth(opts: GraphHealthOptions): Promise<GraphHealthReport> {
	const folder = opts.folder ?? "Zettelkasten/knowledge-graph";
	const mocPath = opts.mocPath ?? "Tags/Knowledge Graph.md";
	const folderPrefix = folder.replace(/\/+$/, "") + "/";
	const idx = await getIndex(opts.vaultPath);

	const folderNotes = [...idx.notes.keys()].filter((p) => p.startsWith(folderPrefix));
	const byBasename = new Map<string, string>(); // basename -> path (vault-wide, for link resolution)
	for (const p of idx.notes.keys()) byBasename.set(basename(p), p);

	// Dead links: a [[target]] in a folder card that resolves to no note.
	// Skip targets that are obviously PROSE artifacts, not note slugs — e.g. a
	// card whose detail text describes a Python "nested list [[...]]" gets the
	// literal `[[...]]` picked up as a wikilink by the extractor. A real note
	// slug starts with an alphanumeric char and has no whitespace.
	const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
	const deadLinks: { from: string; target: string }[] = [];
	for (const p of folderNotes) {
		const meta = idx.notes.get(p)!;
		for (const link of meta.links) {
			if (!SLUG_RE.test(link)) continue; // prose artifact (e.g. "...")
			const target = basename(link);
			if (!byBasename.has(target) && !idx.notes.has(link)) {
				deadLinks.push({ from: p, target: link });
			}
		}
	}

	// MOC drift: compare [[links]] in the MOC to the folder's card basenames.
	const mocAbs = join(opts.vaultPath, mocPath);
	const mocMissing: string[] = []; // cards in folder but not in MOC
	const mocStale: string[] = []; // in MOC but not in folder
	const folderBasenames = new Set(folderNotes.map(basename));
	if (existsSync(mocAbs)) {
		const mocText = readFileSync(mocAbs, "utf8");
		const mocListed = new Set<string>();
		const re = /\[\[([^\]]+)\]\]/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(mocText)) !== null) mocListed.add(basename(m[1]!));
		for (const b of folderBasenames) if (!mocListed.has(b)) mocMissing.push(b);
		for (const b of mocListed) if (!folderBasenames.has(b)) mocStale.push(b);
	} else {
		// No MOC → every card is "missing from MOC".
		for (const b of folderBasenames) mocMissing.push(b);
	}

	// Orphans: folder cards with zero incoming links (vault-wide reverseAdjacency).
	const orphans: string[] = [];
	for (const p of folderNotes) {
		const inbound = idx.reverseAdjacency.get(p);
		if (!inbound || inbound.size === 0) orphans.push(p);
	}

	deadLinks.sort((a, b) => a.from.localeCompare(b.from) || a.target.localeCompare(b.target));
	mocMissing.sort();
	mocStale.sort();
	orphans.sort();

	return {
		vaultPath: opts.vaultPath,
		folder,
		mocPath,
		cardCount: folderNotes.length,
		deadLinks,
		mocMissing,
		mocStale,
		orphans,
		ok: deadLinks.length === 0 && mocMissing.length === 0 && mocStale.length === 0,
	};
}

/** Human-readable health report for CLI / contract-lane output. */
export function formatHealthReport(r: GraphHealthReport): string {
	const head = [
		`vault:   ${r.vaultPath}`,
		`folder:  ${r.folder}/  (${r.cardCount} card(s))`,
		`moc:     ${r.mocPath}`,
		`status:  ${r.ok ? "OK" : "DRIFT"}`,
		`dead-links: ${r.deadLinks.length}`,
		`moc-missing: ${r.mocMissing.length}`,
		`moc-stale: ${r.mocStale.length}`,
		`orphans: ${r.orphans.length} (reported, non-fatal)`,
	];
	const detail: string[] = [];
	if (r.deadLinks.length) {
		detail.push("", "dead links:");
		for (const d of r.deadLinks.slice(0, 12)) detail.push(`  ${d.from} → [[${d.target}]]`);
	}
	if (r.mocMissing.length) {
		detail.push("", "MOC missing (card exists, not listed):");
		for (const b of r.mocMissing.slice(0, 12)) detail.push(`  ${b}`);
	}
	if (r.mocStale.length) {
		detail.push("", "MOC stale (listed, card absent):");
		for (const b of r.mocStale.slice(0, 12)) detail.push(`  ${b}`);
	}
	return [...head, ...detail].join("\n");
}
