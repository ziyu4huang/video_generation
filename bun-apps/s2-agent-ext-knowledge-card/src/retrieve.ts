/**
 * src/retrieve.ts â deterministic knowledge-graph READ side (symmetric to
 * ingest.ts's WRITE side).
 *
 * ingest.ts converges structured records INTO the shared vault folder as
 * cross-linked zettel cards. retrieve.ts reads them BACK OUT for cross-
 * workflow injection: a self-improve loop at Resolve asks "what did OTHER
 * workflows learn that is relevant to my tag space?" and gets a compact
 * digest of cards it does NOT already own.
 *
 * Three primitives (all deterministic â no LLM, no network):
 *
 *   readActiveIds(kbFile)        â parse a workflow's .knowledge.jsonl,
 *                                  return the active record ids (the caller's
 *                                  OWN ids, used to exclude self-cards).
 *
 *   retrieveRecords(opts)        â scan the convergence folder, match ANY of
 *                                  the given tags, rank by shared-tag count,
 *                                  EXCLUDE the caller's own ids, return topK
 *                                  cards with a compact digest.
 *
 *   graphHealth(opts)            â dead-link / MOC-drift / orphan audit scoped
 *                                  to the convergence folder (uses the
 *                                  pi-obsidian VaultIndex substrate).
 *
 *   healGraph(opts)              â auto-heal: regenerate the MOC from on-disk
 *                                  cards + prune dead [[...]] links in-card.
 *                                  Scoped to the convergence folder; NEVER
 *                                  touches human-authored cards outside it.
 *
 * Library only â no ExtensionAPI, no LLM, no network. The zk-query CLI
 * (s2-agent) is a thin shell over these functions.
 *
 * Env (passed through from pi-obsidian): OB_VAULT_PATH / OB_VAULT_DIR.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rankWithHotness, type UsageStats } from "./hotness.ts";
import { getIndex, graphDeadLinks, graphOrphans, invalidateCache, parseFrontmatter } from "@repo/s2-agent-ext-obsidian";
import { writeMoc } from "./ingest.ts";
import { extractFeatures } from "./card-render.ts";
import { extractTitle } from "./graph-health.ts";
import { buildAggTiers, buildLeafTiers, renderTier, type Tier, type TierText } from "./tier-ladder.ts";
import type { KnowledgeRecord, CoverageReport } from "./types.ts";
import { buildMocContent, cardAnatomy, readCardFrontmatterFields, readCardMeta, slugify, normTag } from "./card-format.ts";
import { computeIdf, scoreOverlap, type LinkWeighting } from "@repo/s2-agent-core-interface";
import {
	cosine,
	blendScore,
	defaultEmbedder,
	embedQuery,
	getCardEmbeddings,
	lmStudioAvailable,
	minMaxNorm,
	resolveCardEmbedModel,
	SEMANTIC_ALPHA_DEFAULT,
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
	/** Tier-rendered text (ticket 07 ladder): the requested tier's pre-rendered
	 *  text, DEMOTED one tier shallower while it overflows the per-entry budget
	 *  instead of truncating (OpenViking rule). */
	detail: string;
	/** Tags (normalised). */
	tags: string[];
	/** Shared-tag count with the query (the ranking score before the callout boost). */
	sharedTags: number;
	/** Tree-expansion marker. TWO lanes set it: the flat path's post-ranking
	 *  agg-evidence cards (appended after the ranked list, count-excluded) and
	 *  the hier lane's ranked leaf cards whose score arrived via directory
	 *  propagation rather than their own seed (D27 switch, ticket 05). */
	viaTree?: boolean;
	/** Vault-relative card path. */
	path: string;
	/** Source provenance label. */
	source: string;
	/** True iff the card carries Obsidian callout(s) (P1 feature metadata). */
	hasCallouts: boolean;
	/** First callout headline ("[!warning] ...") â lifted into the digest so the
	 *  highest-signal line is not buried in the truncated prose body. */
	calloutText: string;
	/** Typed graph edges (ticket 03 T5 / D2). OPTIONAL â undefined for cards
	 *  with no `relations:` frontmatter (the default dictionary ingest path
	 *  emits entities only, never relations). When present, the edges are the
	 *  on-disk `relations:` block (already canonicalized by T4's serializer
	 *  write-back); retrieve is a faithful pass-through, it does NOT
	 *  re-normalize. Substrate for ticket 20 + LeanRAG â¢. */
	relations?: Array<{ s: string; rel: string; o: string }>;
	/** EFFECTIVE render tier after demotion (ticket 07): the tier `detail`
	 *  actually holds — shallower than the requested tier when the entry's
	 *  text overflowed its budget. */
	tier: Tier;
	/** Pre-rendered per-tier text (ticket 07 ladder): L0 = title + tags +
	 *  `summary` frontmatter (ticket 05); L1 = body lead (~600 chars) / agg
	 *  `summary` (ticket 06); L2 = full body. Renderers pick a tier and let
	 *  renderTier demote — never slice. */
	tiers: TierText;
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
	/** Render tier (ticket 07 ladder, D0/D5): "abstract" (L0, DEFAULT) |
	 *  "overview" (L1, detail flag) | "full" (L2, explicit request). Selects
	 *  the pre-rendered tier text that lands in each card's `detail`/digest
	 *  line. */
	tier?: Tier;
	/** Per-entry render budget (ticket 07). A tier text that OVERFLOWS this
	 *  budget DEMOTES one tier shallower instead of truncating (OpenViking
	 *  rule, verbatim); only the abstract floor is word-boundary clamped.
	 *  Default: the tier's intrinsic budget (TIER_BUDGETS — i.e. nothing
	 *  demotes unless the caller caps). */
	maxDetailChars?: number;
	/** Ranking weight (SAG-inspired, kg-improvement-plan P8):
	 *  - "count" (default): raw shared-tag count (the pinned baseline).
	 *  - "idf": Î£ IDF(sharedTag) â rare specific tags outrank ubiquitous
	 *    type-tags, improving recall on natural-language queries where the
	 *    caller's tags name a SPECIFIC concept (pi-obsidian) not a type (pattern).
	 *    ADDITIVE + OPT-IN; default preserves the measured tag-path baseline. */
	linkWeighting?: LinkWeighting;
	/** Opt-in body/full-text recall path (kg-improvement-plan follow-on to P8).
	 *  When true, a card is also eligible when query tokens appear in its BODY
	 *  prose (not just its tags), and ranking blends tag-overlap (Ã2, precision)
	 *  with body-token overlap (recall) + the callout boost. Closes the
	 *  knowledge_query recall gap: tags-only 0.48 â 0.84 hit-rate@4 on the
	 *  25-query eval, zero regression. Default false = byte-identical tag-only
	 *  behaviour (drift-guard stays green; no extra file reads). */
	bodyMatch?: boolean;
	/** Opt-in slug-dominant precision path (kg-improvement-plan iter-2, follow-on
	 *  to bodyMatch). When true, a card whose SLUG (filename, derived from the
	 *  record id at ingest) overlaps â¥3 query tokens scores by slugÃ4 â the slug
	 *  is the card's distilled topic fingerprint and beats ubiquitous-tag noise.
	 *  Rescues cards whose tags are generic but whose id names the exact query
	 *  topic (knowledge_query 0.80â0.84 hit-rate@4, zero regression). Works with
	 *  or without bodyMatch; the â¥3 hard gate is essential (additive slug weight
	 *  floods top-4 with weak 1â2-token matches â probed, regresses). Cheap: the
	 *  slug IS the filename, so no extra file read. Default false = unchanged. */
	slugDom?: boolean;
	/** Opt-in semantic (embedding) blend (recall-regime-change-eval, 2026-07-12).
	 *  When true AND a local embedding model (canonical bge-m3 via LM Studio) is
	 *  available, the lexical top-12 pool is UNION'd with a semantic top-12
	 *  (cosine over precomputed card embeddings) and reranked by
	 *  Î±Â·(lexical rank norm) + (1-Î±)Â·(cosine min-max norm). Bridges symptomâcause
	 *  semantic gaps lexical retrieval cannot (measured 0.84 â 1.00 hit-rate@4,
	 *  zero regression, robust Î±â[0.12,0.22]). GRACEFUL FALLBACK: if LM Studio or
	 *  the model is unavailable, or embeddings fail, retrieval is pure lexical
	 *  (the shipped 0.84 path) â no error. Default false = byte-identical baseline.
	 *  Requires `queryText` (the natural-language query to embed). */
	semantic?: boolean;
	/** Natural-language query text to embed when `semantic` is true. The lexical
	 *  path uses `tags` (tokenised); the semantic path embeds THIS string because
	 *  vector similarity needs the query's prose, not its tag tokens. */
	queryText?: string;
	/** Blend weight Î± (lexical) in [0,1]; semantic weight = 1-Î±. Default 0.18
	 *  (center of the measured 1.00 band). */
	semanticAlpha?: number;
	/** Embedding model id (default text-embedding-bge-m3, D3 re-confirmed
	 *  2026-08-23 by ticket 07's eval gate; see core-interface
	 *  embedding-leaf.ts). */
	semanticModel?: string;
	/** INTERNAL test hook: inject a deterministic embedder so the semantic blend
	 *  can be unit-tested without a live LM Studio. When set, the availability
	 *  check is skipped and this embedder backs getCardEmbeddings + embedQuery.
	 *  Never set in production. */
	_testEmbedder?: Embedder;
	/** Opt-in retrieval TRACE (Phase C observability). When true, the result
	 *  carries a `trace` with per-card score/sharedTags/source provenance â lets
	 *  a caller debug why cards surfaced without re-reading the vault. Default
	 *  false = the result is byte-identical to omitting it (no trace computation,
	 *  drift-guard stays green). */
	includeTrace?: boolean;
	/** D18 typed filter (ticket 05 flat-side completion): leaf `type` (frontmatter
	 *  `type`, fallback `record_type`) must match exactly. Mirrors
	 *  HierarchicalOptions.type — the hier lane filters on index `kind`, the flat
	 *  lane on the md frontmatter. Omit for all kinds. */
	type?: string;
	/** D27 default switch override (ticket 05 D36): the default is hier-first
	 *  when `semantic && queryText` (escape-hatch env KCARD_HIER_DEFAULT=0);
	 *  `hier: false` forces the flat path; `hier: true` attempts hier even with
	 *  `semantic: false`. */
	hier?: boolean;
	/** INTERNAL test hook: inject a SurrealClient so the hier-first lane can be
	 *  unit-tested without a live SurrealDB. Never set in production. */
	_hierClient?: import("@repo/s2-agent-core-interface").SurrealClient;
	/** Hotness re-rank (ticket 08, D37/D39): when true (and a SURREAL reader
	 *  is available), the lane's final scores fold by the D37 bounded clamp —
	 *  final = score·(1+β(2h−1)), β=0.1 — with h from the usage feed (live
	 *  GROUP BY over `usage`, D38) + md-mtime decay (D39). Default: env
	 *  `KCARD_HOTNESS_DEFAULT` — absent = ON (the D40 gate'd default), "0" =
	 *  off. A Surreal failure degrades to mtime-only hotness, never an error. */
	hotness?: boolean;
	/** Append the SERVED cards (leaf only, D38 result-boundary feed) to the
	 *  `usage` ledger. Default true on the production path; the eval harness
	 *  passes false for hermetic measurement (and true during its warmup). */
	usageLog?: boolean;
	/** INTERNAL test hook: inject usage aggregates so the fold is unit-tested
	 *  without a live SurrealDB. Never set in production. */
	_usageStats?: UsageStats;
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
		/** Whether the D37 hotness fold was armed (ticket 08). */
		hotness?: boolean;
	};
	/** True only when the semantic blend actually ran (false = off OR fell back). */
	semanticUsed: boolean;
	/** True when the D27 hier-first lane answered (ticket 05 D36). On that lane
	 *  bodyMatch/slugDom/linkWeighting are inert, `scanned` is the seed pool
	 *  (not the vault total) and `excluded` counts hydration failures. */
	hierUsed?: boolean;
	/** Whether the D37 hotness fold actually applied (ticket 08). When false
	 *  the lane said no (or Surreal was unavailable — the fold degrades to
	 *  mtime-only hotness, still bounded). */
	hotnessUsed?: boolean;
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
		/** How the card entered the result set. "hierarchical" = the D27
		 *  default-switch lane (ticket 05 D36 — score is the hier blend +
		 *  propagation score, not sharedTags). */
		source: "lexical" | "semantic" | "both" | "hierarchical";
		/** The D37 hotness score (0.0–1.0) that folded this card's score —
		 *  present only when the trace ran on the folded lane. */
		hotness?: number;
	}>;
}

// ---------------------------------------------------------------------------
// readActiveIds â the caller's OWN active record ids
// ---------------------------------------------------------------------------

/**
 * Parse a workflow's `.knowledge.jsonl` and return the ids of records whose
 * status === "active". These are the caller's own cards â retrieveRecords
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
			// malformed line â skip
		}
	}
	return ids;
}

// ---------------------------------------------------------------------------
// retrieveRecords â cross-workflow tag-ranked retrieval
// ---------------------------------------------------------------------------

/**
 * Scan the convergence folder for cards matching ANY of `opts.tags`, rank by
 * shared-tag count, exclude `opts.excludeIds` (the caller's own cards), and
 * return the topK as a compact digest.
 *
 * Symmetric to ingestRecords: where ingestRecords WRITES cards and computes
 * cross-link neighbours by shared tags, retrieveRecords READS them back and
 * ranks by the same shared-tag signal â so the retrieval ranking is consistent
 * with the graph's own edge weights.
 */
/** Minimal English stop-word set. Query tags equal to one of these are ignored
 *  for body matching â they appear in almost every card and would flood recall
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
 *  this the slug signal is too weak (1â2 common tokens) and a slug weight
 *  floods top-4 with weak matches â probed and rejected (slug2/slug3 regress). */
const SLUG_DOM_THRESHOLD = 3;

/** Count how many query tags appear in the card's SLUG (filename) tokens. The
 *  slug â derived from the record id at ingest â is the card's distilled topic
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

/** md mtime for the D39 decay anchor — 0 on any stat failure (the fold then
 *  decays on the usage half alone; still bounded by β). */
function cardMtimeMs(vaultPath: string, path: string): number {
	try {
		return statSync(join(vaultPath, `${path}.md`)).mtimeMs;
	} catch {
		return 0;
	}
}

export async function retrieveRecords(opts: RetrieveOptions): Promise<RetrieveResult> {
	const folder = opts.folder ?? "Zettelkasten/knowledge-graph";
	const topK = opts.topK ?? 10;
	const tier = opts.tier ?? "abstract";
	const maxDetailChars = opts.maxDetailChars; // undefined = tier-intrinsic budget
	const linkWeighting = opts.linkWeighting ?? "count";
	const bodyMatch = opts.bodyMatch ?? false;
	const slugDom = opts.slugDom ?? false;
	const semantic = opts.semantic ?? false;
	const semanticAlpha = opts.semanticAlpha ?? SEMANTIC_ALPHA_DEFAULT;
	// D22: the default model resolves per call (seam → env → default), so
	// SEMANTIC_EMBED_MODEL / __piEmbeddingConfig actually control the cards side.
	const semanticModel = resolveCardEmbedModel(opts.semanticModel);
	const includeTrace = opts.includeTrace ?? false;
	// Hotness (ticket 08, D37–D39): the D37 bounded fold applies by default
	// (opt-out env, mirroring the D36 hier switch) unless the caller is a test
	// doing pure flat/semantic — same guard as `hierOn` below. The usage READ
	// degrades to an empty map on any failure (fold degrades to mtime-only,
	// still bounded); fixture-stem absence from any real `usage` table keeps
	// unit-test outcomes deterministic on machines with Surreal up (F3 note).
	// A hermetic test run has NO live-client path: an injected embedder with
	// neither a client nor injected usage stats (the loadUsageStats fallback
	// would otherwise hit the live service).
	const testMode = Boolean(opts._testEmbedder) && !opts._hierClient && !opts._usageStats;
	const hotnessOn = (opts.hotness ?? process.env.KCARD_HOTNESS_DEFAULT !== "0") && !testMode;
	// Usage echo WRITES the served stems to the ledger — an append to a real
	// store, so default OFF; production entry points (knowledge_query /
	// zk.retrieve / CLI) opt in explicitly, never a bare library caller.
	const usageLogOn = opts.usageLog === true && !testMode;
	let statsPromise: Promise<UsageStats> | null = null;
	const loadUsageStats = (): Promise<UsageStats> => {
		if (!statsPromise) {
			statsPromise = opts._usageStats
				? Promise.resolve(opts._usageStats)
				: (async () => {
						// NOTE: NEVER the _hierClient seam — a flat-lane test that
						// injected it asserts the client stays UNTOUCHED when hier
						// is off; the usage reader makes its own production client.
						try {
							const { makeContextClient, usageStats } = await import("./surreal-index.ts");
							return await usageStats(makeContextClient());
						} catch {
							return new Map();
						}
				  })();
		}
		return statsPromise;
	};
	/** Per-card D37 hotness that folded the final scores (trace provenance;
	 *  populated only when hotnessOn — never in non-trace paths). */
	const foldedHotness = new Map<string, number>();
	const recordUsage = async (res: RetrieveResult): Promise<RetrieveResult> => {
		if (usageLogOn && res.cards.length > 0) {
			// Stems = the served leaf cards (agg viaTree evidence is not a card
			// access); path is "folder/stem" → last segment is the stem.
			const stems = [...new Set(
				res.cards.filter((c) => !c.viaTree).map((c) => c.path.split("/").pop()!).filter((s) => s.length > 0),
			)];
			if (stems.length > 0) {
				try {
					const { makeContextClient, logUsage } = await import("./surreal-index.ts");
					await logUsage(makeContextClient(), stems);
				} catch {
					// non-fatal — usage logging never degrades retrieval
				}
			}
		}
		return res;
	};
	const folderAbs = join(opts.vaultPath, folder);
	const queryTags = new Set(opts.tags.map(normTag).filter(Boolean));
	const excludeIds = new Set((opts.excludeIds ?? []).map((id) => id));
	const excludeSlugs = new Set([...excludeIds].map((id) => slugify(id)));

	if (!existsSync(folderAbs)) {
		return { count: 0, cards: [], digest: "", folder, scanned: 0, excluded: 0 };
	}

	// D27 default switch (ticket 05 D36): hier-first when the semantic lane is
	// on and a query exists — authorized by the D25 gate (hier 17/20 hit@5,
	// MRR 0.700 vs flat 17/20 + 0.688). The hier lane's leaf cards HYDRATE
	// through the flat md-read path (buildRetrievedCard) so the
	// RetrieveResult/digest/tier contract every consumer pins is preserved
	// byte-shape. Any hier failure (Surreal down, no seeds, zero hydrated,
	// STALE index — the freshness gate) falls through to the unchanged flat
	// path below. Escape hatches: opts.hier === false, or KCARD_HIER_DEFAULT=0.
	// Test hygiene (reviewer F3): a unit test injecting an embedder but NO
	// hier client is testing the flat/semantic path — never attempt live
	// Surreal from it (production never sets _testEmbedder).
	const hierOn = (opts.hier ?? (semantic && process.env.KCARD_HIER_DEFAULT !== "0"))
		&& Boolean(opts.queryText)
		&& !(opts._testEmbedder && !opts._hierClient);
	if (hierOn) {
		const hier = await tryHierarchicalDefault({
			client: opts._hierClient,
			vaultPath: opts.vaultPath,
			folder,
			queryText: opts.queryText!,
			topK,
			type: opts.type,
			model: semanticModel,
			embedder: opts._testEmbedder,
			tier,
			maxDetailChars,
			queryTags,
			excludeIds,
			excludeSlugs,
			origTags: opts.tags,
			includeTrace,
			hotness: hotnessOn ? loadUsageStats : undefined,
			hotnessFold: foldedHotness,
			optsSnapshot: { bodyMatch, slugDom, semantic, topK, semanticAlpha, hotness: hotnessOn },
		});
		if (hier) return recordUsage(hier);
	}

	// IDF pre-scan (only when linkWeighting === "idf"): collect every card's tag
	// set so the IDF table spans the full folder. The default "count" mode skips
	// this entirely â no behaviour change for the pinned baseline.
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

	let scored: (RetrievedCard & { _score: number })[] = [];
	let scanned = 0;
	let excluded = 0;

	for (const name of readdirSync(folderAbs)) {
		if (!name.endsWith(".md")) continue;
		// LeanRAG â¡ (ticket 05): derived aggregation MOCs never RANK â surfaced
		// only via post-ranking tree expansion (lineage-matched, capped).
		if (/^agg-L\d+-\d+\.md$/.test(name)) continue;
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
		// the pinned baseline; "idf" = Î£ IDF(sharedTag), SAG-inspired P8). Both
		// modes exclude the ubiquitous "zettel" tag (scoreOverlap handles it).
		const shared = scoreOverlap(queryTags, meta.tags, idfTable, linkWeighting);
		// Opt-in slug-dom precision: the card's SLUG (filename) is its distilled
		// topic fingerprint. When â¥3 query tokens appear in the slug, the card is
		// eligible AND scores dominantly â rescues cards whose tags are generic but
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
		// D15 discriminator: frontmatter `type` first (typed cards, D16/D18),
		// record_type fallback — mirrors the index `kind` derivation.
		const type = typeof fields.type === "string" && fields.type
			? fields.type
			: typeof fields.recordType === "string" ? fields.recordType : "pattern";
		// D18 typed filter (ticket 05 flat side): exact leaf-type match.
		if (opts.type && type !== opts.type) continue;
		const source = typeof fields.source === "string" ? fields.source : "unknown";
		// Tier ladder (ticket 07): pre-render L0/L1/L2, then render the
		// requested tier under the caller's budget — overflow DEMOTES a tier
		// (never truncates); the abstract floor alone is word-boundary clamped.
		const displayTags = [...meta.tags].filter((t) => t !== "zettel");
		const tiers = buildLeafTiers({
			title,
			tags: displayTags,
			summary: fields.summary || undefined,
			body: cardAnatomy(content).body.trim(),
		});
		const rendered = renderTier(tiers, tier, maxDetailChars);

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
		// buildRagTask Step-3 score (0.7Ãsearch + 0.3Ãlinks). The two read paths
		// use different score signals AND have different access to feature
		// metadata: retrieveRecords is the deterministic library â it reads each
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
			detail: rendered.text,
			tier: rendered.tier,
			tiers,
			tags: displayTags,
			sharedTags: shared,
			path: `${folder}/${cardSlug}`,
			source,
			hasCallouts: meta.hasCallouts,
			calloutText,
			relations: parseRelationsBlock(content),
			// Blend score: tag overlap Ã2 (precision) + body-token overlap (recall) +
			// callout boost. TagÃ2 keeps precise tag matches dominant while body adds
			// recall â measured zero-regression vs the tag-only baseline.
			// slugDom (iter-2): when the card's slug overlaps â¥3 query tokens, the slug
			// fingerprint DOMINATES (slugÃ4) â the highest-signal deterministic match,
			// beating ubiquitous-tag noise (e.g. a card whose id literally names the
			// query topic but whose tags are generic). The â¥3 hard gate is essential:
			// additive slug weight floods top-4 with weak 1â2-token matches (probed,
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
	// Î±Â·lexRankNorm + (1-Î±)Â·cosNorm. Returns null on any embedding failure â
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
			tier,
			maxDetailChars,
			queryTags,
			excludeIds,
			excludeSlugs,
			scanned,
			excluded,
			origTags: opts.tags,
			testEmbedder: opts._testEmbedder,
			includeTrace,
			hotness: hotnessOn ? loadUsageStats : undefined,
			hotnessFold: foldedHotness,
			optsSnapshot: { bodyMatch, slugDom, semantic, topK, semanticAlpha, hotness: hotnessOn },
		});
		if (sem) return recordUsage(sem);
	}

	// D37 hotness fold — the FALL-THROUGH lane (the semantic lane folds inside
	// trySemanticBlend after its blend and returns above; a blend-failure
	// fall-through folds here). The fold only ever re-ranks a FINAL score —
	// never a lane's input pool (the semantic pool selection happened above).
	// Bounded: final = score·(1+β(2h−1)), β=0.1; h from the usage feed
	// aggregates + md-mtime recency (D38/D39). Folds even when stats are empty
	// (mtime-only h) — never a no-op, always within the ±10% bound.
	if (hotnessOn) {
		const stats = await loadUsageStats();
		const from = scored.map((c) => ({
			stem: c.path.split("/").pop()!, // path = "folder/stem" (buildRetrievedCard shape)
			score: c._score,
			mtimeMs: cardMtimeMs(opts.vaultPath, c.path),
		}));
		const folded = rankWithHotness(from, stats);
		scored = folded.map((f) => {
			foldedHotness.set(scored[f._idx]!.id, f.hotness);
			return { ...scored[f._idx]!, _score: f.finalScore };
		});
	}

	const topScored = scored.slice(0, topK);
	const top = topScored.map(({ _score, ...rest }) => rest);
	// LeanRAG ② (ticket 05): auto tree-expansion — append lineage-matched
	// aggregation summaries as evidence AFTER the ranked list (ranking stays
	// authoritative). No agg files → zero code-path change (byte-identical).
	const expanded = await expandWithTree(folderAbs, top, maxDetailChars);

	return recordUsage({
		count: top.length,
		cards: [...top, ...expanded],
		digest: formatDigest(top, opts.tags),
		folder,
		scanned,
		excluded,
		trace: includeTrace
			? {
					options: { bodyMatch, slugDom, semantic, topK, semanticAlpha, hotness: hotnessOn },
					semanticUsed: false,
					hotnessUsed: hotnessOn && foldedHotness.size > 0,
					candidatePool: scored.length,
					scanned,
					cards: topScored.map((c) => ({
						id: c.id,
						path: c.path,
						score: c._score,
						sharedTags: c.sharedTags,
						hasCallouts: c.hasCallouts,
						source: "lexical" as const,
						hotness: foldedHotness.get(c.id),
					})),
			  }
			: undefined,
	});
}

/** D27 default-switch lane (ticket 05 D36): hierarchicalRetrieve first, its
 *  leaf cards hydrated through the flat md-read path so the returned
 *  RetrieveResult is shape-identical to the flat one (same RetrievedCard
 *  fields, same formatDigest rendering). Returns null on ANY hier failure —
 *  the caller falls through to the flat path.
 *
 *  FRESHNESS GATE (reviewer F1/F5): the lane only serves when the index is
 *  fresh — md file count === index card count AND index embed_model === the
 *  resolved model. A count/model mismatch (post-snapshot ingest, removal,
 *  model swap) falls back to flat, so the hier default is never BLIND to new
 *  cards. In-place EDITS of existing cards keep the count stable and can
 *  still rank stale FTS text until the next explicit rebuild — bounded fog,
 *  rebuild automation is the recorded fold-back. NOTE on this lane:
 *  `scanned` reports the hier seed pool (NOT the vault total the flat lane
 *  reports) and `excluded` counts hydration failures (NOT caller-owned
 *  cards); bodyMatch/slugDom/linkWeighting are inert when hier answers —
 *  the trace's `hierUsed: true` marks the lane so callers can tell. */
async function tryHierarchicalDefault(args: {
	client?: import("@repo/s2-agent-core-interface").SurrealClient;
	vaultPath: string;
	folder: string;
	queryText: string;
	topK: number;
	type?: string;
	model: string;
	embedder?: Embedder;
	tier: Tier;
	maxDetailChars: number | undefined;
	queryTags: Set<string>;
	excludeIds: Set<string>;
	excludeSlugs: Set<string>;
	origTags: string[];
	includeTrace: boolean;
	/** D37 provider (ticket 08): resolves the usage aggregates to fold with. */
	hotness?: () => Promise<UsageStats>;
	/** Shared per-card hotness provenance (trace honesty — populated by the fold). */
	hotnessFold?: Map<string, number>;
	optsSnapshot: { bodyMatch: boolean; slugDom: boolean; semantic: boolean; topK: number; semanticAlpha?: number; hotness?: boolean };
}): Promise<RetrieveResult | null> {
	const { hierarchicalRetrieve } = await import("./hierarchical-retrieval.ts");
	const { makeContextClient, indexStatus } = await import("./surreal-index.ts");
	let client: import("@repo/s2-agent-core-interface").SurrealClient;
	try {
		client = args.client ?? makeContextClient();
	} catch {
		return null;
	}
	// Freshness gate (F1/F5): md count vs index count + embed-model match.
	// Cheap: one readdirSync + one status query.
	try {
		const status = await indexStatus(client);
		if (!status.present) return null;
		if (status.embedModel !== args.model) return null;
		const mdCount = readdirSync(join(args.vaultPath, args.folder)).filter((n) => n.endsWith(".md")).length;
		if (status.cardCount !== mdCount) return null;
	} catch {
		return null;
	}
	let res: Awaited<ReturnType<typeof hierarchicalRetrieve>>;
	try {
		res = await hierarchicalRetrieve(client, {
			query: args.queryText,
			topK: args.topK,
			type: args.type,
			model: args.model,
			embedder: args.embedder,
			includeTrace: args.includeTrace,
		});
	} catch {
		return null;
	}
	if (!res.ok || res.cards.length === 0) return null;

	const hydrated: (RetrievedCard & { _score: number; hierScore: number })[] = [];
	let excluded = 0;
	for (const h of res.cards) {
		const built = buildRetrievedCard(
			args.vaultPath, args.folder, h.path, args.tier, args.maxDetailChars,
			args.queryTags, args.excludeIds, args.excludeSlugs,
		);
		if (!built) {
			excluded++;
			continue;
		}
		// Hier cards can be typed via frontmatter `type` (D15) — hydrate the
		// discriminator from the md (the md is canonical for RENDERING, D2).
		hydrated.push({ ...built, viaTree: h.viaTree || undefined, _score: 0, hierScore: h.score });
	}
	if (hydrated.length === 0) return null;

	// D37 hotness fold (ticket 08): bounded re-rank of the hydrated hier
	// scores — same provider/contract as the flat lanes (usage aggregates +
	// md-mtime recency, β clamp, sticky pre-fold ties).
	let ranked = hydrated;
	if (args.hotness) {
		const stats = await args.hotness();
		const from = hydrated.map((c) => ({
			stem: c.path.split("/").pop()!,
			score: c.hierScore,
			mtimeMs: cardMtimeMs(args.vaultPath, c.path),
		}));
		const folded = rankWithHotness(from, stats);
		ranked = folded.map((f) => {
			const card = hydrated[f._idx]!;
			args.hotnessFold?.set(card.id, f.hotness);
			return { ...card, hierScore: f.finalScore };
		});
	}

	const top = ranked.map(({ _score, hierScore, ...rest }) => rest);
	return {
		count: top.length,
		cards: top,
		digest: formatDigest(top, args.origTags),
		folder: args.folder,
		scanned: res.trace?.seedPool ?? res.cards.length,
		excluded,
		trace: args.includeTrace
			? {
					options: args.optsSnapshot,
					semanticUsed: res.trace?.semanticLane ?? true,
					hierUsed: true,
					hotnessUsed: Boolean(args.hotness),
					candidatePool: res.cards.length,
					scanned: res.trace?.seedPool ?? res.cards.length,
					cards: ranked.map((c) => ({
						id: c.id,
						path: c.path,
						score: c.hierScore,
						sharedTags: c.sharedTags,
						hasCallouts: c.hasCallouts,
						source: "hierarchical" as const,
						hotness: args.hotnessFold?.get(c.id),
					})),
			  }
			: undefined,
	};
}

/** LeanRAG ② tree expansion (ticket 05): load agg-L*-* MOCs, keep nodes whose
 *  sources (lineage union) contain any ranked card id; append <=3 nearest-layer
 *  summaries as viaTree evidence cards. Pure read; never re-ranks. */
async function expandWithTree(
	folderAbs: string,
	ranked: RetrievedCard[],
	maxDetailChars: number | undefined,
): Promise<RetrievedCard[]> {
	if (ranked.length === 0) return [];
	const rankedIds = new Set(ranked.map((c) => c.id));
	const matches: { layer: number; card: RetrievedCard }[] = [];
	for (const name of readdirSync(folderAbs)) {
		if (!/^agg-L\d+-\d+\.md$/.test(name)) continue;
		const raw = readFileSync(join(folderAbs, name), "utf8");
		const { data } = parseFrontmatter(raw);
		const sources = flattenScalarList(data.sources);
		if (!sources.some((s) => rankedIds.has(s))) continue;
		const layer = Number(data.layer ?? 0) || 0;
		const summary = typeof data.summary === "string" ? data.summary : "";
		const entities = flattenScalarList(data.entities);
		const aggTitle = `Aggregation L${layer}`;
		// Ticket 07: agg nodes render L1 (the composed `summary:`, ticket 06);
		// the ladder bottoms out there — an agg card has no deeper prose body.
		const aggTiers = buildAggTiers({ title: aggTitle, tags: entities, summary });
		const aggRendered = renderTier(aggTiers, "overview", maxDetailChars);
		matches.push({
			layer,
			card: {
				id: typeof data.id === "string" ? data.id : name.replace(/\.md$/, ""),
				title: aggTitle,
				type: "aggregation",
				detail: aggRendered.text,
				tier: aggRendered.tier,
				tiers: aggTiers,
				tags: entities,
				sharedTags: 0,
				path: name.replace(/\.md$/, ""),
				source: "aggregation",
				hasCallouts: false,
				calloutText: "",
				viaTree: true,
			},
		});
	}
	matches.sort((a, b) => b.layer - a.layer);
	return matches.slice(0, 3).map((m) => m.card);
}
/** Flat string-list frontmatter flattener (agg MOCs carry flat lists only). */
function flattenScalarList(v: unknown): string[] {
	if (!Array.isArray(v)) return typeof v === "string" && v ? [v] : [];
	return v.filter((x): x is string => typeof x === "string" && x !== "");
}

/** Parse the additive `relations: [{s,rel,o},â¦]` frontmatter block into typed
 *  edges (ticket 03 T5 / D2). retrieve.ts can't reuse obsidian's
 *  `parseFrontmatter` here: its block-list branch captures scalar items only
 *  and breaks on the first non-`- ` line, so a nested `{s,rel,o}` map would
 *  collapse to `["s: a"]`. This walker reads the nested entries directly.
 *
 *  CANONICALIZATION DECISION â Option C (raw pass-through, D3): retrieve does
 *  NOT re-normalize `rel`, and zk must NOT import hermes's `normalizeRelation`
 *  (hermes is the spine that CALLS zk â zkâhermes would be a backward edge; zk
 *  has zero `@repo/s2-agent-ext-hermes-memory` deps/imports). The on-disk block
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

	// Locate the top-level `relations:` key (empty value â block form).
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
		if (/^\S/.test(ln)) break; // next top-level key â relations block ended
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
			// s/rel/o are plain ids + a predicate key â strip a defensive
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
	tier: Tier,
	maxDetailChars: number | undefined,
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
	const title = extractTitle(content);
	const displayTags = [...meta.tags].filter((t) => t !== "zettel");
	const tiers = buildLeafTiers({
		title,
		tags: displayTags,
		summary: fields.summary || undefined,
		body: cardAnatomy(content).body.trim(),
	});
	const rendered = renderTier(tiers, tier, maxDetailChars);
	return {
		id: meta.source_id ?? cardSlug,
		title,
		// D15 discriminator: frontmatter `type` first (mirrors index `kind`).
		type: typeof fields.type === "string" && fields.type
			? fields.type
			: typeof fields.recordType === "string" ? fields.recordType : "pattern",
		detail: rendered.text,
		tier: rendered.tier,
		tiers,
		tags: displayTags,
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
 *  rerank by Î±Â·lexRankNorm + (1-Î±)Â·cosNorm. Returns null on any embedding
 *  failure so the caller falls back to pure lexical. */
async function trySemanticBlend(args: {
	scored: (RetrievedCard & { _score: number })[];
	vaultPath: string;
	folder: string;
	topK: number;
	queryText?: string;
	alpha: number;
	model: string;
	tier: Tier;
	maxDetailChars: number | undefined;
	queryTags: Set<string>;
	excludeIds: Set<string>;
	excludeSlugs: Set<string>;
	scanned: number;
	excluded: number;
	origTags: string[];
	testEmbedder?: Embedder;
	includeTrace?: boolean;
	/** D37 provider (ticket 08): resolves the usage aggregates to fold with. */
	hotness?: () => Promise<UsageStats>;
	/** Shared per-card hotness provenance (trace honesty — populated by the fold). */
	hotnessFold?: Map<string, number>;
	optsSnapshot: { bodyMatch: boolean; slugDom: boolean; semantic: boolean; topK: number; semanticAlpha: number; hotness?: boolean };
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
				args.vaultPath, args.folder, p, args.tier, args.maxDetailChars,
				args.queryTags, args.excludeIds, args.excludeSlugs,
			);
			if (built) unionByPath.set(p, built);
		}
	}

	// Cosine min-max norm over the union; blend by Î±Â·lexRank + (1-Î±)Â·cosNorm.
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
	// D37 hotness fold (ticket 08): AFTER the blend — the fold re-ranks the
	// final score; it must never reshape the lane's pool selection above.
	let rankEntries = blended;
	if (args.hotness) {
		const stats = await args.hotness();
		const from = blended.map((c) => ({
			stem: c.path.split("/").pop()!,
			score: c._score,
			mtimeMs: cardMtimeMs(args.vaultPath, c.path),
		}));
		const folded = rankWithHotness(from, stats);
		rankEntries = folded.map((f) => {
			const card = blended[f._idx]!;
			args.hotnessFold?.set(card.id, f.hotness);
			return { ...card, _score: f.finalScore };
		});
	}
	const topBlended = rankEntries.slice(0, args.topK);
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
					hotnessUsed: Boolean(args.hotness),
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
						hotness: args.hotnessFold?.get(c.id),
					})),
			  }
			: undefined,
	};
}

/** Build a compact grouped digest for injection into a workflow's Resolve
 *  phase. Grouped by type, highest-shared first. Each line renders the card's
 *  already-tier-resolved `detail` (ticket 07: L0 abstract by default, demoted
 *  never truncated — the 160-char slice is gone; the effective tier is named
 *  per line so a caller can see when an entry demoted). */
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
			const calloutPrefix = c.calloutText ? `${c.calloutText} â ` : "";
			parts.push(`- ${calloutPrefix}${c.detail} (${c.source}) [${c.tier}]`);
		}
	}
	return parts.join("\n");
}

// Graph-health lives in ./graph-health.ts (hermes-arch-13 wave 3); re-exported here for existing importers.
export { graphHealth, healGraph, formatHealth } from "./graph-health.ts";
export type { GraphHealthOptions, GraphHealthResult, HealResult } from "./graph-health.ts";
