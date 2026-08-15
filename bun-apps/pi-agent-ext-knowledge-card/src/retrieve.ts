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
import {
	slugify,
	normTag,
	writeMoc,
	extractFeatures,
	type KnowledgeRecord,
	type CoverageReport,
} from "./ingest.ts";
import { buildMocContent, cardAnatomy, readCardFrontmatterFields, readCardMeta } from "./card-format.ts";
import { computeIdf, scoreOverlap, type LinkWeighting } from "@repo/pi-agent-ext-core-interface";
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
	/** Typed graph edges (ticket 03 T5 / D2). OPTIONAL — undefined for cards
	 *  with no `relations:` frontmatter (the default dictionary ingest path
	 *  emits entities only, never relations). When present, the edges are the
	 *  on-disk `relations:` block (already canonicalized by T4's serializer
	 *  write-back); retrieve is a faithful pass-through, it does NOT
	 *  re-normalize. Substrate for ticket 20 + LeanRAG ③. */
	relations?: Array<{ s: string; rel: string; o: string }>;
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
	/** Ranking weight (SAG-inspired, kg-improvement-plan P8):
	 *  - "count" (default): raw shared-tag count (the pinned baseline).
	 *  - "idf": Σ IDF(sharedTag) — rare specific tags outrank ubiquitous
	 *    type-tags, improving recall on natural-language queries where the
	 *    caller's tags name a SPECIFIC concept (pi-obsidian) not a type (pattern).
	 *    ADDITIVE + OPT-IN; default preserves the measured tag-path baseline. */
	linkWeighting?: LinkWeighting;
	/** Opt-in body/full-text recall path (kg-improvement-plan follow-on to P8).
	 *  When true, a card is also eligible when query tokens appear in its BODY
	 *  prose (not just its tags), and ranking blends tag-overlap (×2, precision)
	 *  with body-token overlap (recall) + the callout boost. Closes the
	 *  knowledge_query recall gap: tags-only 0.48 → 0.84 hit-rate@4 on the
	 *  25-query eval, zero regression. Default false = byte-identical tag-only
	 *  behaviour (drift-guard stays green; no extra file reads). */
	bodyMatch?: boolean;
	/** Opt-in slug-dominant precision path (kg-improvement-plan iter-2, follow-on
	 *  to bodyMatch). When true, a card whose SLUG (filename, derived from the
	 *  record id at ingest) overlaps ≥3 query tokens scores by slug×4 — the slug
	 *  is the card's distilled topic fingerprint and beats ubiquitous-tag noise.
	 *  Rescues cards whose tags are generic but whose id names the exact query
	 *  topic (knowledge_query 0.80→0.84 hit-rate@4, zero regression). Works with
	 *  or without bodyMatch; the ≥3 hard gate is essential (additive slug weight
	 *  floods top-4 with weak 1–2-token matches — probed, regresses). Cheap: the
	 *  slug IS the filename, so no extra file read. Default false = unchanged. */
	slugDom?: boolean;
	/** Opt-in semantic (embedding) blend (recall-regime-change-eval, 2026-07-12).
	 *  When true AND a local embedding model (nomic-embed-text via LM Studio) is
	 *  available, the lexical top-12 pool is UNION'd with a semantic top-12
	 *  (cosine over precomputed card embeddings) and reranked by
	 *  α·(lexical rank norm) + (1-α)·(cosine min-max norm). Bridges symptom→cause
	 *  semantic gaps lexical retrieval cannot (measured 0.84 → 1.00 hit-rate@4,
	 *  zero regression, robust α∈[0.12,0.22]). GRACEFUL FALLBACK: if LM Studio or
	 *  the model is unavailable, or embeddings fail, retrieval is pure lexical
	 *  (the shipped 0.84 path) — no error. Default false = byte-identical baseline.
	 *  Requires `queryText` (the natural-language query to embed). */
	semantic?: boolean;
	/** Natural-language query text to embed when `semantic` is true. The lexical
	 *  path uses `tags` (tokenised); the semantic path embeds THIS string because
	 *  vector similarity needs the query's prose, not its tag tokens. */
	queryText?: string;
	/** Blend weight α (lexical) in [0,1]; semantic weight = 1-α. Default 0.18
	 *  (center of the measured 1.00 band). */
	semanticAlpha?: number;
	/** Embedding model id (default text-embedding-nomic-embed-text-v1.5). */
	semanticModel?: string;
	/** INTERNAL test hook: inject a deterministic embedder so the semantic blend
	 *  can be unit-tested without a live LM Studio. When set, the availability
	 *  check is skipped and this embedder backs getCardEmbeddings + embedQuery.
	 *  Never set in production. */
	_testEmbedder?: Embedder;
	/** Opt-in retrieval TRACE (Phase C observability). When true, the result
	 *  carries a `trace` with per-card score/sharedTags/source provenance — lets
	 *  a caller debug why cards surfaced without re-reading the vault. Default
	 *  false = the result is byte-identical to omitting it (no trace computation,
	 *  drift-guard stays green). */
	includeTrace?: boolean;
}

export interface RetrieveResult {
	count: number;
	cards: RetrievedCard[];
	digest: string;
	folder: string;
	scanned: number;
	excluded: number;
	/** Opt-in retrieval TRACE (Phase C observability, SAG-inspired SearchTrace).
	 *  Present only when `includeTrace: true` was passed. Captures, per returned
	 *  card: the final score, shared-tag count, callout flag, and how the card
	 *  entered the set (lexical / semantic / both), plus the active options +
	 *  candidate-pool size + whether the semantic path was actually used. Lets a
	 *  caller debug WHY a card surfaced (or didn't) without re-reading the vault. */
	trace?: RetrieveTrace;
}

/** Per-card + per-retrieval provenance for the trace (Phase C observability). */
export interface RetrieveTrace {
	/** The options that produced this result (provenance). */
	options: {
		bodyMatch: boolean;
		slugDom: boolean;
		semantic: boolean;
		topK: number;
		semanticAlpha?: number;
	};
	/** True only when the semantic blend actually ran (false = off OR fell back). */
	semanticUsed: boolean;
	/** Candidate-pool size before the top-K cut (|scored|, lexical stage). */
	candidatePool: number;
	/** Total vault cards scanned in the convergence folder. */
	scanned: number;
	/** Per-card breakdown for the RETURNED top-K, in rank order. */
	cards: Array<{
		id: string;
		path: string;
		/** Final ranking score (post-blend, comparable within this result). */
		score: number;
		/** Shared-tag count with the query (the precision signal). */
		sharedTags: number;
		/** Whether the card carries a callout (the +0.5 boost source). */
		hasCallouts: boolean;
		/** How the card entered the result set. */
		source: "lexical" | "semantic" | "both";
	}>;
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
/** Minimal English stop-word set. Query tags equal to one of these are ignored
 *  for body matching — they appear in almost every card and would flood recall
 *  with false positives. Standard IR practice; mirrors the eval harness's
 *  fullTextProxy logic (`scripts/real-retrieval-measure.mjs`). */
const BODY_STOP = new Set([
	"the", "and", "for", "with", "that", "this", "how", "why", "does", "was", "were",
	"after", "before", "when", "what", "have", "has", "not", "but", "are", "is", "it",
	"to", "of", "in", "on", "my", "our", "your", "their", "can", "should", "would",
	"from", "into", "about", "than", "then", "been", "being", "its", "all", "any",
	"some", "out", "off", "over", "get", "got", "run", "set", "put", "new", "old",
	"one", "two", "use", "used", "using",
]);

/** Count how many query tags appear in the card body's prose. Frontmatter is
 *  stripped (so a card's own tags don't double-count as body hits); the body is
 *  tokenized to lowercase alphanumeric tokens; a query tag that is itself a stop
 *  word never counts. Pure + allocation-free over the query set. */
function bodyTokenOverlap(content: string, queryTags: Set<string>): number {
	const body = content.replace(/^---\n[\s\S]*?\n---/, "");
	const tokenSet = new Set(
		body.toLowerCase().replace(/[^a-z0-9-]+/g, " ").split(" ")
			.filter((t) => t.length >= 3 && !BODY_STOP.has(t)),
	);
	let n = 0;
	for (const t of queryTags) {
		if (t.length < 3 || BODY_STOP.has(t)) continue;
		if (tokenSet.has(t)) n++;
	}
	return n;
}

/** Slug-tokenization noise filter: BODY_STOP plus the type/section prefixes
 *  baked into converged-card slugs (from the record id namespace or the
 *  gotcha/lever/pattern record_type). These carry no topic signal and would
 *  inflate slug-overlap for every card in a namespace (e.g. all `auto-memory-*`
 *  cards share "auto","memory"). */
const SLUG_STOP = new Set([
	...BODY_STOP,
	"auto", "memory", "gotcha", "lever", "avoid", "pattern", "metric",
	"false", "positive", "note", "card", "zettel", "self", "improve",
]);

/** Minimum slug-token overlap for the slug-dom precision branch to fire. Below
 *  this the slug signal is too weak (1–2 common tokens) and a slug weight
 *  floods top-4 with weak matches — probed and rejected (slug2/slug3 regress). */
const SLUG_DOM_THRESHOLD = 3;

/** Count how many query tags appear in the card's SLUG (filename) tokens. The
 *  slug — derived from the record id at ingest — is the card's distilled topic
 *  fingerprint, so slug overlap is the highest-signal deterministic match. Type
 *  prefixes + stop words are filtered so namespace noise (auto-memory-, gotcha-)
 *  never counts. Pure + no file read (the slug IS the filename). */
function slugTokenOverlap(slug: string, queryTags: Set<string>): number {
	const slugSet = new Set(
		slug.toLowerCase().split("-").filter((t) => t.length >= 3 && !SLUG_STOP.has(t)),
	);
	let n = 0;
	for (const t of queryTags) {
		if (t.length < 3 || BODY_STOP.has(t)) continue;
		if (slugSet.has(t)) n++;
	}
	return n;
}

export async function retrieveRecords(opts: RetrieveOptions): Promise<RetrieveResult> {
	const folder = opts.folder ?? "Zettelkasten/knowledge-graph";
	const topK = opts.topK ?? 10;
	const maxDetailChars = opts.maxDetailChars ?? 240;
	const linkWeighting = opts.linkWeighting ?? "count";
	const bodyMatch = opts.bodyMatch ?? false;
	const slugDom = opts.slugDom ?? false;
	const semantic = opts.semantic ?? false;
	const semanticAlpha = opts.semanticAlpha ?? SEMANTIC_ALPHA_DEFAULT;
	const semanticModel = opts.semanticModel ?? SEMANTIC_MODEL_DEFAULT;
	const includeTrace = opts.includeTrace ?? false;
	const folderAbs = join(opts.vaultPath, folder);
	const queryTags = new Set(opts.tags.map(normTag).filter(Boolean));
	const excludeIds = new Set((opts.excludeIds ?? []).map((id) => id));
	const excludeSlugs = new Set([...excludeIds].map((id) => slugify(id)));

	if (!existsSync(folderAbs)) {
		return { count: 0, cards: [], digest: "", folder, scanned: 0, excluded: 0 };
	}

	// IDF pre-scan (only when linkWeighting === "idf"): collect every card's tag
	// set so the IDF table spans the full folder. The default "count" mode skips
	// this entirely — no behaviour change for the pinned baseline.
	let idfTable = new Map<string, number>();
	if (linkWeighting === "idf") {
		const folderTagSets: Set<string>[] = [];
		for (const name of readdirSync(folderAbs)) {
			if (!name.endsWith(".md")) continue;
			const meta = readCardMeta(join(folderAbs, name));
			if (meta) folderTagSets.push(meta.tags);
		}
		idfTable = computeIdf(folderTagSets);
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

		// Shared-tag score under the selected weighting ("count" = raw integer,
		// the pinned baseline; "idf" = Σ IDF(sharedTag), SAG-inspired P8). Both
		// modes exclude the ubiquitous "zettel" tag (scoreOverlap handles it).
		const shared = scoreOverlap(queryTags, meta.tags, idfTable, linkWeighting);
		// Opt-in slug-dom precision: the card's SLUG (filename) is its distilled
		// topic fingerprint. When ≥3 query tokens appear in the slug, the card is
		// eligible AND scores dominantly — rescues cards whose tags are generic but
		// whose id names the exact query topic. Cheap: the slug is the filename, no
		// extra read. Default slugDom=false keeps the pinned baseline.
		const slugOverlap = slugDom ? slugTokenOverlap(cardSlug, queryTags) : 0;
		// Opt-in body-match recall: a card with zero tag overlap is still eligible
		// when query tokens appear in its body prose. Default bodyMatch=false keeps
		// the cheap skip (no file read for no-overlap cards) + the pinned baseline.
		if (shared <= 0 && !bodyMatch && !(slugDom && slugOverlap > 0)) continue;
		// Read the card content for title/detail/type.
		const content = readFileSync(abs, "utf8");
		const bodyOverlap = bodyMatch ? bodyTokenOverlap(content, queryTags) : 0;
		if (shared <= 0 && bodyOverlap <= 0 && slugOverlap <= 0) continue; // no overlap of any kind
		// Defense-in-depth: never surface retired/superseded cards as live
		// knowledge. Archived cards already live under _archive/ (excluded by
		// the flat readdirSync), but this guard also catches any stale card that
		// was marked retired in-place without being moved.
		const fields = readCardFrontmatterFields(content);
		if (fields.status === "retired" || fields.status === "superseded") {
			excluded++;
			continue;
		}
		const title = extractTitle(content);
		const detail = extractDetail(content, maxDetailChars);
		const type = typeof fields.recordType === "string" ? fields.recordType : "pattern";
		const source = typeof fields.source === "string" ? fields.source : "unknown";

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
			relations: parseRelationsBlock(content),
			// Blend score: tag overlap ×2 (precision) + body-token overlap (recall) +
			// callout boost. Tag×2 keeps precise tag matches dominant while body adds
			// recall — measured zero-regression vs the tag-only baseline.
			// slugDom (iter-2): when the card's slug overlaps ≥3 query tokens, the slug
			// fingerprint DOMINATES (slug×4) — the highest-signal deterministic match,
			// beating ubiquitous-tag noise (e.g. a card whose id literally names the
			// query topic but whose tags are generic). The ≥3 hard gate is essential:
			// additive slug weight floods top-4 with weak 1–2-token matches (probed,
			// regresses). Default (bodyMatch=false, slugDom=false): shared + calloutBoost.
			_score: slugDom && slugOverlap >= SLUG_DOM_THRESHOLD
				? slugOverlap * 4 + calloutBoost
				: bodyMatch
					? shared * 2 + bodyOverlap + calloutBoost
					: shared + calloutBoost,
		});
	}

	scored.sort((a, b) => b._score - a._score || a.id.localeCompare(b.id));

	// Opt-in semantic blend (recall-regime-change-eval). Default off = unchanged.
	// Union the lexical top-12 with a semantic top-12 (cosine), rerank by
	// α·lexRankNorm + (1-α)·cosNorm. Returns null on any embedding failure →
	// graceful fall-through to pure lexical below.
	if (semantic) {
		const sem = await trySemanticBlend({
			scored,
			vaultPath: opts.vaultPath,
			folder,
			topK,
			queryText: opts.queryText,
			alpha: semanticAlpha,
			model: semanticModel,
			maxDetailChars,
			queryTags,
			excludeIds,
			excludeSlugs,
			scanned,
			excluded,
			origTags: opts.tags,
			testEmbedder: opts._testEmbedder,
			includeTrace,
			optsSnapshot: { bodyMatch, slugDom, semantic, topK, semanticAlpha },
		});
		if (sem) return sem;
	}

	const topScored = scored.slice(0, topK);
	const top = topScored.map(({ _score, ...rest }) => rest);

	return {
		count: top.length,
		cards: top,
		digest: formatDigest(top, opts.tags),
		folder,
		scanned,
		excluded,
		trace: includeTrace
			? {
					options: { bodyMatch, slugDom, semantic, topK, semanticAlpha },
					semanticUsed: false,
					candidatePool: scored.length,
					scanned,
					cards: topScored.map((c) => ({
						id: c.id,
						path: c.path,
						score: c._score,
						sharedTags: c.sharedTags,
						hasCallouts: c.hasCallouts,
						source: "lexical" as const,
					})),
			  }
			: undefined,
	};
}

/** Parse the additive `relations: [{s,rel,o},…]` frontmatter block into typed
 *  edges (ticket 03 T5 / D2). retrieve.ts can't reuse obsidian's
 *  `parseFrontmatter` here: its block-list branch captures scalar items only
 *  and breaks on the first non-`- ` line, so a nested `{s,rel,o}` map would
 *  collapse to `["s: a"]`. This walker reads the nested entries directly.
 *
 *  CANONICALIZATION DECISION — Option C (raw pass-through, D3): retrieve does
 *  NOT re-normalize `rel`, and zk must NOT import hermes's `normalizeRelation`
 *  (hermes is the spine that CALLS zk — zk→hermes would be a backward edge; zk
 *  has zero `@repo/pi-agent-ext-hermes-memory` deps/imports). The on-disk block
 *  is already canonical regardless: T4's serializer write-back
 *  (`KnowledgeSerializer.serialize`, the sole write site) emits the
 *  already-normalized-in-memory `graph.relations`, and T4's deserialize
 *  canonicalizes on read. A card therefore reaches the vault carrying
 *  canonical predicates; retrieve returns them as-emitted (D3: normalize on
 *  read at the serializer; retrieve is a vault-read path). Returns undefined
 *  when the card has no `relations:` block (the dictionary ingest path emits
 *  entities only, never relations) so plain cards carry no `relations: []`
 *  noise. */
function parseRelationsBlock(
	content: string,
): { s: string; rel: string; o: string }[] | undefined {
	const lines = content.split("\n");
	// Operate only inside the leading `---`-fenced frontmatter.
	if (lines.length === 0 || lines[0]!.trim() !== "---") return undefined;
	let end = -1;
	for (let k = 1; k < lines.length; k++) {
		if (lines[k]!.trim() === "---") { end = k; break; }
	}
	if (end === -1) return undefined;

	// Locate the top-level `relations:` key (empty value ⇒ block form).
	let relIdx = -1;
	for (let k = 1; k < end; k++) {
		if (/^relations\s*:\s*$/.test(lines[k]!)) { relIdx = k; break; }
	}
	if (relIdx === -1) return undefined;

	// Walk the indented body until the next top-level key / fence, splitting
	// into list-item entries on the ` - ` delimiter.
	const entries: string[][] = [];
	let cur: string[] | null = null;
	for (let k = relIdx + 1; k < end; k++) {
		const ln = lines[k]!;
		if (/^\S/.test(ln)) break; // next top-level key → relations block ended
		if (/^\s*-\s+/.test(ln)) { cur = []; entries.push(cur); }
		if (!cur) continue;
		cur.push(ln.replace(/^\s*-\s+/, "").trim());
	}

	const out: { s: string; rel: string; o: string }[] = [];
	for (const entry of entries) {
		let s: string | undefined;
		let rel: string | undefined;
		let o: string | undefined;
		for (const seg of entry) {
			const kv = seg.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
			if (!kv) continue;
			// s/rel/o are plain ids + a predicate key — strip a defensive
			// surrounding quote pair (serializer emits unquoted; a hand-authored
			// card may quote).
			const val = kv[2]!.trim().replace(/^["']|["']$/g, "");
			if (kv[1] === "s") s = val;
			else if (kv[1] === "rel") rel = val;
			else if (kv[1] === "o") o = val;
		}
		if (typeof s === "string" && typeof rel === "string" && typeof o === "string") {
			out.push({ s, rel, o });
		}
	}
	return out.length > 0 ? out : undefined;
}

/** Build a RetrievedCard from a card file (for semantic-only cards not in
 *  the lexical pool). Applies the same retired/superseded + exclusion guards
 *  as the main loop. Returns null if the card should be skipped. */
function buildRetrievedCard(
	vaultPath: string,
	folder: string,
	cardPath: string,
	maxDetailChars: number,
	queryTags: Set<string>,
	excludeIds: Set<string>,
	excludeSlugs: Set<string>,
): (RetrievedCard & { _score: number }) | null {
	const cardSlug = cardPath.slice(folder.length + 1); // strip "folder/"
	const abs = join(vaultPath, `${cardPath}.md`);
	if (!existsSync(abs)) return null;
	const meta = readCardMeta(abs);
	if (!meta) return null;
	if (meta.source_id && excludeIds.has(meta.source_id)) return null;
	if (excludeSlugs.has(cardSlug)) return null;
	const content = readFileSync(abs, "utf8");
	const fields = readCardFrontmatterFields(content);
	if (fields.status === "retired" || fields.status === "superseded") return null;
	let calloutText = "";
	if (meta.hasCallouts) calloutText = extractFeatures(content).calloutTexts[0] ?? "";
	return {
		id: meta.source_id ?? cardSlug,
		title: extractTitle(content),
		type: typeof fields.recordType === "string" ? fields.recordType : "pattern",
		detail: extractDetail(content, maxDetailChars),
		tags: [...meta.tags].filter((t) => t !== "zettel"),
		sharedTags: scoreOverlap(queryTags, meta.tags, new Map(), "count"),
		path: cardPath,
		source: typeof fields.source === "string" ? fields.source : "unknown",
		hasCallouts: meta.hasCallouts,
		calloutText,
		relations: parseRelationsBlock(content),
		_score: 0,
	};
}

/** Opt-in semantic blend. Union lexical top-12 with semantic top-12 (cosine),
 *  rerank by α·lexRankNorm + (1-α)·cosNorm. Returns null on any embedding
 *  failure so the caller falls back to pure lexical. */
async function trySemanticBlend(args: {
	scored: (RetrievedCard & { _score: number })[];
	vaultPath: string;
	folder: string;
	topK: number;
	queryText?: string;
	alpha: number;
	model: string;
	maxDetailChars: number;
	queryTags: Set<string>;
	excludeIds: Set<string>;
	excludeSlugs: Set<string>;
	scanned: number;
	excluded: number;
	origTags: string[];
	testEmbedder?: Embedder;
	includeTrace?: boolean;
	optsSnapshot: { bodyMatch: boolean; slugDom: boolean; semantic: boolean; topK: number; semanticAlpha: number };
}): Promise<RetrieveResult | null> {
	if (!args.queryText) return null;
	// Test hook: skip the network availability check when an embedder is injected.
	if (!args.testEmbedder && !(await lmStudioAvailable(args.model))) return null;
	const cardEmb = await getCardEmbeddings(args.vaultPath, args.folder, args.model, args.testEmbedder ?? defaultEmbedder);
	const qv = await embedQuery(args.queryText, args.model, args.testEmbedder ?? defaultEmbedder);
	if (!cardEmb || !qv) return null;

	// Semantic cosine over ALL cards; top-12 by similarity.
	const semScored = cardEmb.paths
		.map((p, i) => ({ path: p, cos: cosine(qv, cardEmb.vectors[i]!) }))
		.sort((a, b) => b.cos - a.cos);
	const semTopPaths = new Set(semScored.slice(0, 12).map((s) => s.path));

	// Lexical pool top-12 + rank-norm ((12-r)/12; semantic-only cards get 0).
	const lexPool = args.scored.slice(0, 12);
	const lexRankNorm = new Map<string, number>();
	lexPool.forEach((c, r) => lexRankNorm.set(c.path, (12 - r) / 12));

	// Union: lexical pool + semantic top-12 (build semantic-only cards on demand).
	const unionByPath = new Map<string, RetrievedCard & { _score: number }>();
	for (const c of lexPool) unionByPath.set(c.path, c);
	for (const p of semTopPaths) {
		if (!unionByPath.has(p)) {
			const built = buildRetrievedCard(
				args.vaultPath, args.folder, p, args.maxDetailChars,
				args.queryTags, args.excludeIds, args.excludeSlugs,
			);
			if (built) unionByPath.set(p, built);
		}
	}

	// Cosine min-max norm over the union; blend by α·lexRank + (1-α)·cosNorm.
	const unionPaths = [...unionByPath.keys()];
	const cosines = unionPaths.map((p) => {
		const idx = cardEmb.paths.indexOf(p);
		return idx >= 0 ? cosine(qv, cardEmb.vectors[idx]!) : -1;
	});
	const cosNorm = minMaxNorm(cosines);
	const alpha = args.alpha;
	const blended = unionPaths
		.map((p, i) => {
			const card = unionByPath.get(p)!;
			const lr = lexRankNorm.get(p) ?? 0;
			const cn = cosNorm[i] ?? 0;
			return { ...card, _score: blendScore(lr, cn, alpha) };
		})
		.sort((a, b) => b._score - a._score || a.id.localeCompare(b.id));
	const topBlended = blended.slice(0, args.topK);
	const top = topBlended.map(({ _score, ...rest }) => rest);
	// Trace source classification: a card is in the lexical pool (top-12), the
	// semantic top-12, or both.
	const lexPoolPaths = new Set(lexPool.map((c) => c.path));
	return {
		count: top.length,
		cards: top,
		digest: formatDigest(top, args.origTags),
		folder: args.folder,
		scanned: args.scanned,
		excluded: args.excluded,
		trace: args.includeTrace
			? {
					options: args.optsSnapshot,
					semanticUsed: true,
					candidatePool: args.scored.length,
					scanned: args.scanned,
					cards: topBlended.map((c) => ({
						id: c.id,
						path: c.path,
						score: c._score,
						sharedTags: c.sharedTags,
						hasCallouts: c.hasCallouts,
						source: lexPoolPaths.has(c.path)
							? semTopPaths.has(c.path)
								? "both"
								: "lexical"
							: "semantic",
					})),
			  }
			: undefined,
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
function extractTitle(content: string): string {
	const title = cardAnatomy(content).title.trim();
	return title || "(untitled)";
}

/** Extract the 核心想法 (core idea) body section, truncated (anatomy via cardAnatomy). */
function extractDetail(content: string, maxChars: number): string {
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
