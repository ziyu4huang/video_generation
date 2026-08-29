/**
 * src/ingest.ts — deterministic knowledge-graph convergence primitive.
 *
 * The pi-knowledge-card tools (zk_card / zk_ask) are LLM-subagent
 * coordinators: they decompose free-form markdown into atomic zettels. That is
 * the right tool for UNSTRUCTURED text, but the self-improve loops already
 * produce STRUCTURED knowledge — `.claude/workflows/*.knowledge.jsonl` records
 * with a fixed 12-key schema (id/type/title/detail/tags/dimension/confidence/
 * status/superseded_by/evidence/...). Routing those through an LLM subagent
 * would be lossy, non-deterministic, and would re-introduce exactly the
 * "siloed per-workflow" fragmentation this module exists to dissolve.
 *
 * zk_ingest is the deterministic counterpart: it maps each structured record
 * 1:1 onto a canonical zettel card in ONE shared vault folder, dedup'd by the
 * record's stable id, cross-linked by shared tags, and indexed by a MOC. The
 * graph then spans every source (workflow-jsonl today; hermes + auto-memory
 * later) because every converged card lives in the same folder and shares the
 * same tag space — a flux2 gotcha and a krea2 gotcha with overlapping tags get
 * a `[[...]]` edge, and `zk_ask` (graph-enhanced RAG over the whole vault)
 * answers cross-source questions for free.
 *
 * Canonical card schema (frontmatter; validateZettelNote requires id/created/
 * tags with tags[0]=="zettel" and does NOT reject extra keys, so the lifecycle
 * + provenance fields ride along as extended frontmatter):
 *
 *   ---
 *   id: <record.id>                 # stable canonical key (namespaced, e.g. ltx:cfg-scale-7-lever)
 *   created: YYYY-MM-DD             # best-effort from evidence.first_seen / extracted_at
 *   tags: [zettel, <record.type>, ...record.tags, ...dimension parts]
 *   sources: [<provenance>]
 *   source: workflow-jsonl          # source family
 *   source_id: <record.id>          # dedup key (== id; kept explicit for scanners)
 *   record_type: lever              # lever|avoid|pattern|gotcha|metric|false_positive|experience|event|case|preference|reference
 *   status: active                  # active|superseded|retired
 *   superseded_by: <id|null>
 *   confidence: 0.93
 *   dimension: <string|null>
 *   ---
 *
 * Library only — no ExtensionAPI, no LLM, no network. The extension tool
 * (zk_ingest) and the `s2-agent cli` subcommand (zk-ingest) are thin shells
 * over `ingestRecords`.
 *
 * Env (passed through from pi-obsidian): OB_VAULT_PATH / OB_VAULT_DIR.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { scheduleCardRebuild } from "./surreal-index.ts";
import {
	validateZettelNote,
	ZETTEL_MAX_BYTES,
} from "@repo/s2-agent-ext-obsidian";
import { tokeniseText, bestMatch } from "./similarity.ts";
import {
	buildMocContent,
	clampSummary,
	readCardMeta,
	readCardSummary,
	slugify,
} from "./card-format.ts";
import { cardTags, renderCard, truncateDetail } from "./card-render.ts";
import { tokeniseCardFile, wikiMergeIntoCard } from "./wiki-match.ts";
import {
	embedRecordText,
	llmDedupDecision,
	loadDedupEmbeddings,
	planDedup,
	DEDUP_GRAY_THRESHOLD_DEFAULT,
	DEDUP_MERGE_THRESHOLD_DEFAULT,
	type DedupDecision,
} from "./semantic-dedup.ts";
import { extractDate } from "./adapters.ts";
import {
	computeIdf,
	scoreOverlap,
	type ExtractedEntity,
} from "@repo/s2-agent-core-interface";
import {
	condenseSummary,
	firstSentenceSummary,
	resolveExtractor,
	SUMMARY_BODY_BUDGET,
	type Relation,
} from "./extractor.ts";
import type {
	CardOutcome,
	CoverageByFamily,
	CoverageReport,
	CoverageSourceSpec,
	IngestOptions,
	IngestSummary,
	KnowledgeRecord,
} from "./types.ts";

// Re-export kept on this module's long-standing import surface: retrieve.ts,
// the CLI, and __tests__ import readCardMeta via ./ingest.ts.
export { readCardMeta } from "./card-format.ts";

// ---------------------------------------------------------------------------
// MOC
// ---------------------------------------------------------------------------

/** Build (or rebuild) a MOC grouping every card in the folder by record_type
 *  then by tag. Fully deterministic — regenerated from the on-disk cards each
 *  run, so it never drifts. */
export function writeMoc(
	vaultPath: string,
	mocRel: string,
	cardsAbs: string[],
	dryRun: boolean,
): boolean {
	const content = buildMocContent(cardsAbs);
	const mocAbs = join(vaultPath, mocRel);
	if (dryRun) return true;
	mkdirSync(dirname(mocAbs), { recursive: true });
	writeFileSync(mocAbs, content, "utf8");
	return true;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Ingest a batch of structured records into the shared vault as zettel cards.
 *
 * Dedup: canonical key is `record.id`. The card filename is `slug(id).md` under
 * the convergence folder, so a re-ingest of the same record upserts in place
 * (created vs updated vs unchanged decided by content hash). Cross-links are
 * computed across ALL cards in the folder — so a card from a prior source
 * (e.g. hermes) links to today's workflow-jsonl card when they share a tag.
 *
 * Wiki-aware convergence (opts.wikiAware): before minting a new card, each
 * incoming record is matched against EXISTING cards in the folder (token-set
 * Jaccard over title + detail). A match at or above `wikiThreshold` UPSERTS
 * into the existing canonical card (append evidence + bump last_seen) instead
 * of creating a parallel duplicate — the Alluvium "add to the existing page"
 * pattern. Canonical-id policy: FIRST-WINS — the existing card keeps its id;
 * later sources upsert evidence into it.
 *
 * Semantic dedup pre-filter (ticket 13, `opts.semanticDedup` — opt-in, OFF by
 * default): records the Jaccard pass misses are cosine-compared against the
 * `.knowledge-semantic` card cache; ≥ 0.90 top-1 merges deterministically, the
 * 0.75–0.90 gray band asks ONE advisory local-LLM skip/create/merge decision
 * (guardrailed — malformed output fails open to create), below 0.75 creates.
 * A cache/embedder miss degrades to the Jaccard-only path (offline-safe). See
 * src/semantic-dedup.ts.
 */

export async function coverageReport(opts: {
	vaultPath: string;
	folder?: string;
	sources: CoverageSourceSpec[];
}): Promise<CoverageReport> {
	const folderAbs = join(opts.vaultPath, opts.folder ?? "Zettelkasten/knowledge-graph");

	// V: vault cards grouped by source family (via readCardMeta — same path ingest uses).
	const vaultByFamily = new Map<string, Set<string>>();
	if (existsSync(folderAbs)) {
		for (const name of readdirSync(folderAbs)) {
			if (!name.endsWith(".md")) continue;
			const meta = readCardMeta(join(folderAbs, name));
			if (!meta?.source_id) continue;
			// The card's `source` frontmatter is the sourceLabel ("<family>:<detail>"
			// — verified for every real caller: host-fns builds `${source}:…`, the
			// CLI passes "hermes:pipeline" etc.). Extract the family prefix so the
			// vault set is grouped by the SAME family key CoverageSourceSpec uses.
			// Legacy/empty-source cards fall through to "unknown" (never a checked
			// family → not counted as sourceOrphaned, gracefully ignored).
			const fam = (meta.source ?? "").split(":")[0]?.trim() || "unknown";
			const set = vaultByFamily.get(fam) ?? new Set<string>();
			set.add(meta.source_id);
			vaultByFamily.set(fam, set);
		}
	}

	// Per-family diff. A family not present in the vault contributes vault=0
	// (every expected id is missing); a family in the vault but not checked is
	// left alone (no cross-family false-positive).
	const byFamily: Record<string, CoverageByFamily> = {};
	const missing: string[] = [];
	const sourceOrphaned: string[] = [];
	let expected = 0;
	let vaultTotal = 0;
	let matched = 0;
	for (const src of opts.sources) {
		const E = new Set(src.records.map((r) => r.id));
		const V = vaultByFamily.get(src.family) ?? new Set<string>();
		const famMissing = [...E].filter((id) => !V.has(id));
		const famOrphaned = [...V].filter((id) => !E.has(id));
		const famMatched = E.size - famMissing.length;
		byFamily[src.family] = {
			expected: E.size,
			vault: V.size,
			matched: famMatched,
			missing: famMissing,
			sourceOrphaned: famOrphaned,
		};
		missing.push(...famMissing);
		sourceOrphaned.push(...famOrphaned);
		expected += E.size;
		vaultTotal += V.size;
		matched += famMatched;
	}
	return { expected, vault: vaultTotal, matched, missing, sourceOrphaned, byFamily };
}

export async function ingestRecords(
	records: KnowledgeRecord[],
	opts: IngestOptions,
): Promise<IngestSummary> {
	const folder = opts.folder ?? "Zettelkasten/knowledge-graph";
	const mocPath = opts.mocPath ?? "Tags/Knowledge Graph.md";
	const maxLinks = opts.maxLinks ?? 8;
	const maxDetailChars = opts.maxDetailChars ?? 32_000;
	const dryRun = opts.dryRun === true;
	const wikiAware = opts.wikiAware === true;
	const wikiThreshold = opts.wikiThreshold ?? 0.85;
	const linkWeighting = opts.linkWeighting ?? "count";
	// kg.llm gate (D4, ticket 03 T3): the effective flag is IngestOptions.kgLlm
	// with a `PI_KG_LLM=1` env fallback (env mirrors the LMSTUDIO_BASE_URL read
	// style in semantic.ts). Threaded to the extractor-selection point
	// (resolveExtractor). Default OFF → dictionary path. Phase-2 SHIPPED: when
	// ON, resolveExtractor returns LlmRelationExtractor, which itself degrades
	// to dictionary-equivalent output on any LLM failure (never-throws).
	const kgLlm = opts.kgLlm ?? process.env.PI_KG_LLM === "1";
	const kgLlmModel = opts.kgLlmModel ?? process.env.PI_KG_LLM_MODEL;
	// Summary condense gate (schema v2 / D4): default OFF (tier rule — default
	// ingest is LLM-free); over-budget bodies keep the clamped deterministic
	// first sentence unless explicitly enabled here or via env.
	const summaryLlm = opts.summaryLlm ?? process.env.PI_KG_SUMMARY_LLM === "1";
	// Semantic dedup pre-filter (ticket 13, P3): opt-in, OFF by default (tier
	// rule). Vector pre-filter over the .knowledge-semantic cache + gray-zone
	// advisory LLM decision — see src/semantic-dedup.ts. A cache/embedder
	// miss degrades to the Jaccard-only path (offline-safe).
	const semanticDedup = opts.semanticDedup ?? process.env.PI_KG_SEMANTIC_DEDUP === "1";
	const dedupMergeThreshold = opts.dedupMergeThreshold ?? DEDUP_MERGE_THRESHOLD_DEFAULT;
	const dedupGrayThreshold = opts.dedupGrayThreshold ?? DEDUP_GRAY_THRESHOLD_DEFAULT;
	const folderAbs = join(opts.vaultPath, folder);

	if (!existsSync(opts.vaultPath)) {
		throw new Error(`vault does not exist: ${opts.vaultPath}`);
	}
	if (!dryRun) mkdirSync(folderAbs, { recursive: true });

	// 1. Snapshot existing cards in the folder (for cross-link + collision +
	//    wiki-aware matching). When wikiAware is on we also capture each card's
	//    source_id + tokenised title/body so incoming records can be matched
	//    against them BEFORE minting a new card.
	interface ExistingCard {
		abs: string;
		tags: Set<string>;
		sourceId: string;
		tokens: Set<string>;
	}
	const existing = new Map<string, ExistingCard>(); // basename -> meta
	if (existsSync(folderAbs)) {
		for (const name of readdirSync(folderAbs)) {
			if (!name.endsWith(".md")) continue;
			const abs = join(folderAbs, name);
			const meta = readCardMeta(abs);
			if (!meta) continue;
			let content = "";
			let tokens = new Set<string>();
			if (wikiAware) {
				try {
					content = readFileSync(abs, "utf8");
					tokens = tokeniseCardFile(content);
				} catch { /* best effort */ }
			}
			existing.set(name.slice(0, -3), {
				abs,
				tags: meta.tags,
				sourceId: meta.source_id ?? name.slice(0, -3),
				tokens,
			});
		}
	}

	const summary: IngestSummary = {
		source: opts.source,
		sourceLabel: opts.sourceLabel,
		total: records.length,
		created: 0,
		updated: 0,
		unchanged: 0,
		skipped: 0,
		linked: 0,
		wikiMerged: 0,
		semanticMerged: 0,
		semanticSkipped: 0,
		dedupDecisions: [],
		mocUpdated: false,
		vaultPath: opts.vaultPath,
		folder,
		cards: [],
		parseErrors: [],
	};

	// 1b. Wiki-aware pre-filter: match each incoming record against existing
	//     cards. A match UPSERTS into the canonical card (first-wins policy);
	//     only unmatched records fall through to the normal create/update path.
	//     This is what prevents the 10+ id namespaces from growing parallel
	//     duplicate cards for the same lesson.
	const today = new Date().toISOString().slice(0, 10);
	// Semantic dedup embeddings, loaded ONCE per batch (ticket 13): the cached
	// card vectors of the folder under the injectable embedder. null (no
	// folder, embedder failure, corrupt cache) or empty → every record takes
	// today's Jaccard-only path; the gray-zone LLM is never reached without a
	// working embedder (offline-safe degrade).
	const dedupEmb =
		semanticDedup && existing.size > 0
			? await loadDedupEmbeddings(opts.vaultPath, folder, opts._testEmbedder)
			: null;
	const dedupSourceIds = new Map<string, string>();
	for (const [name, c] of existing.entries()) dedupSourceIds.set(name, c.sourceId);
	const pendingRecords: typeof records = [];
	for (const rec of records) {
		let wikiMatched = false;
		// The exact-id skip is shared by BOTH matchers (Jaccard + semantic):
		// a record whose canonical id is already on disk takes the normal
		// upsert path below — neither pre-filter may merge it elsewhere.
		let exactId = false;
		if ((wikiAware || semanticDedup) && existing.size > 0) {
			for (const c of existing.values()) {
				if (c.sourceId === rec.id) { exactId = true; break; }
			}
		}
		if (!exactId && wikiAware && existing.size > 0) {
			const recTokens = tokeniseText(`${rec.title} ${rec.detail}`);
			if (recTokens.size > 0) {
				const candidateBasenames = [...existing.keys()];
				const candidates = [...existing.values()];
				const candidateTokens = candidates.map((c) => c.tokens);
				const match = bestMatch(recTokens, candidateTokens, wikiThreshold);
				if (match.index >= 0) {
					const targetBasename = candidateBasenames[match.index]!;
					const target = candidates[match.index]!;
					const outcome = wikiMergeIntoCard(
						target.abs, rec, opts.sourceLabel, match.similarity, today, dryRun,
					);
					summary.wikiMerged++;
					if (outcome === "updated") summary.updated++;
					else summary.unchanged++;
					summary.cards.push({
						id: rec.id,
						path: `${folder}/${targetBasename}.md`,
						status: outcome,
						links: 0,
					});
					wikiMatched = true;
				}
			}
		}
		// Semantic pre-filter (ticket 13): only for records the Jaccard pass
		// did NOT already merge. ≥ merge threshold → deterministic merge;
		// gray band → ONE advisory LLM decision (guardrailed, fail-open);
		// below → straight create (falls through to pendingRecords).
		if (!wikiMatched && !exactId && semanticDedup && dedupEmb) {
			const queryVec = await embedRecordText(rec, opts._testEmbedder);
			let decision: DedupDecision;
			if (!queryVec) {
				decision = { decision: "create", via: "embed-failed" };
			} else {
				const plan = planDedup(
					queryVec, dedupEmb.paths, dedupEmb.vectors, dedupSourceIds,
					dedupMergeThreshold, dedupGrayThreshold,
				);
				if (plan.kind === "merge") decision = { decision: "merge", target: plan.candidate, via: "vector" };
				else if (plan.kind === "gray") decision = await llmDedupDecision(rec, plan.candidates, opts._dedupFetch);
				else decision = { decision: "create", via: "below-gray" };
			}
			if (decision.decision === "merge") {
				const target = existing.get(decision.target.basename);
				if (target) {
					const outcome = wikiMergeIntoCard(
						target.abs, rec, opts.sourceLabel, decision.target.sim, today, dryRun,
						"semantic-merged",
					);
					summary.semanticMerged++;
					if (outcome === "updated") summary.updated++;
					else summary.unchanged++;
					summary.cards.push({
						id: rec.id,
						path: `${folder}/${decision.target.basename}.md`,
						status: outcome,
						links: 0,
					});
					wikiMatched = true;
				}
				// A cache-named target absent from the folder snapshot (stale
				// cache) falls through to create — never merges blind.
			} else if (decision.decision === "skip") {
				// The LLM judged the record a duplicate adding nothing: not
				// minted, not merged — intentionally dropped (counted, traced).
				summary.semanticSkipped++;
				wikiMatched = true;
			}
			summary.dedupDecisions.push({
				id: rec.id,
				sim: decision.decision === "merge" ? decision.target.sim : null,
				via: decision.via,
				target: decision.decision === "merge" ? decision.target.basename : null,
			});
		}
		if (!wikiMatched) pendingRecords.push(rec);
	}

	// 2. Resolve a target filename per record (handle slug collisions).
	const planned: {
		rec: KnowledgeRecord;
		rel: string;
		abs: string;
		basename: string;
	}[] = [];
	const plannedById = new Map<string, string>(); // canonical id → basename (in-batch upsert)
	const usedBasenames = new Set(existing.keys());
	for (const rec of pendingRecords) {
		let base = slugify(rec.id);
		// In-batch dedup: a canonical id already planned in THIS batch upserts onto
		// its basename (mirrors the on-disk same-id path below) instead of
		// disambiguating to `<slug>-2` and emitting a duplicate card. Without this,
		// two records sharing an id in a single fresh batch (card not yet on disk)
		// produce `<slug>.md` + `<slug>-2.md` — violating "dedup by canonical id".
		const alreadyPlanned = plannedById.get(rec.id);
		if (alreadyPlanned) {
			base = alreadyPlanned; // upsert onto the already-planned basename (last wins)
		} else {
			// Disambiguate slug collisions where the existing file is a DIFFERENT id.
			let candidate = base;
			let n = 2;
			while (usedBasenames.has(candidate)) {
				const prevAbs = join(folderAbs, `${candidate}.md`);
				const prev = readCardMeta(prevAbs);
				if (prev && prev.source_id === rec.id) {
					base = candidate; // same record → upsert in place
					break;
				}
				candidate = `${base}-${n++}`;
			}
			base = candidate;
			plannedById.set(rec.id, base);
			usedBasenames.add(base);
		}
		const rel = `${folder}/${base}.md`;
		planned.push({ rec, rel, abs: join(opts.vaultPath, rel), basename: base });
	}

	// 3. Compute cross-link neighbours for each planned card against the full
	//    folder tag graph (existing + this batch). Ranking weight is selected by
	//    `linkWeighting`: "count" (default, pinned iter-7 baseline) = raw
	//    shared-tag count; "idf" (SAG-inspired, P8) = Σ IDF(sharedTag) so rare
	//    specific bridges (pi-obsidian) outrank ubiquitous type-tags (pattern).
	const plannedTags = new Map(planned.map((p) => [p.basename, new Set(cardTags(p.rec))]));
	// Candidate pool keyed by basename so a card present BOTH on disk
	// (`existing`) AND in this batch (`planned`) — i.e. an upsert / re-ingest
	// — is counted ONCE (planned tags win, they're the freshest). Without this
	// dedup, re-ingesting a source that already has on-disk neighbours would
	// emit duplicate `相關：[[...]]` lines.
	const pool = new Map<string, Set<string>>();
	for (const [n, m] of existing.entries()) pool.set(n, m.tags);
	for (const [n, t] of plannedTags.entries()) pool.set(n, t);
	// IDF table over the full pool (only computed when needed; O(pool) pass).
	const idfTable = linkWeighting === "idf" ? computeIdf([...pool.values()]) : new Map<string, number>();
	const allNeighbours: Map<string, string[]> = new Map(); // basename -> targets
	for (const p of planned) {
		const myTags = plannedTags.get(p.basename)!;
		const scored: { name: string; shared: number }[] = [];
		for (const [name, tags] of pool) {
			if (name === p.basename) continue;
			const shared = scoreOverlap(myTags, tags, idfTable, linkWeighting);
			if (shared > 0) scored.push({ name, shared });
		}
		scored.sort((a, b) => b.shared - a.shared || a.name.localeCompare(b.name));
		allNeighbours.set(
			p.basename,
			scored.slice(0, maxLinks).map((s) => s.name),
		);
	}

	// kg.llm extractor (Phase-2 T3): resolved ONCE above the per-card loop
	// (T2 review NIT-1) — no per-card construction, no per-card env re-read.
	// With kgLlm ON this is the `LlmRelationExtractor` and runs for EVERY card
	// regardless of linkWeighting (its relations are the write authority); with
	// kgLlm OFF (default) it is the dictionary singleton and the flow below is
	// byte-identical to Phase-1 (extractor consulted only under idf, entities
	// only). `_extractor` is the test-injection seam (canned chat fixtures).
	const extractor =
		opts._extractor ?? resolveExtractor(kgLlm, kgLlmModel ? { kgLlmModel } : undefined);

	// 4. Render + write each card (or report only, in dryRun).
	for (const p of planned) {
		let rec = p.rec;
		const created =
			extractDate(rec.evidence?.first_seen, rec.evidence?.extracted_at, rec.extracted_at) ||
			"1970-01-01";
		const tags = cardTags(rec);
		const links = allNeighbours.get(p.basename) ?? [];
		// Typed entities (P8) + LLM relations (Phase-2 T3):
		// - Entities for frontmatter stay IDF-GATED (the dictionary/idf contract
		//   is unchanged); pre-supplied rec.entities (from JSONL) always win.
		// - When kgLlm is ON, the extractor runs REGARDLESS of linkWeighting —
		//   under idf its (LLM or degraded-dictionary) entities feed the same
		//   frontmatter slot; under non-idf the run is for RELATIONS only and
		//   entity frontmatter is still skipped.
		// - kgLlm OFF: EXACT Phase-1 flow — extractor only under idf, entities
		//   only, no relations ever (dictionary write-authorivity guard).
		let entities: ExtractedEntity[] | undefined;
		let relations: Relation[] | undefined;
		if (kgLlm) {
			// P2 FIX C: the prompt sees the SAME capped detail the rendered card
			// writes (truncateDetail + maxDetailChars) — never the raw record.
			const llmText = `${rec.title} ${truncateDetail(rec.detail, maxDetailChars)}`;
			const llmResult = await extractor.extract(llmText);
			if (linkWeighting === "idf") {
				entities = (rec.entities as ExtractedEntity[] | undefined)?.length
					? (rec.entities as ExtractedEntity[])
					: llmResult.entities;
			}
			relations = llmResult.relations;
		} else if (linkWeighting === "idf") {
			entities = (rec.entities as ExtractedEntity[] | undefined)?.length
				? (rec.entities as ExtractedEntity[])
				: (await extractor.extract(`${rec.title} ${rec.detail}`)).entities;
		}

		// Summary L0 (schema v2 / D4). Resolution order keeps re-ingest
		// byte-stable: explicit rec.summary > the on-disk summary of the card
		// being upserted (an LLM-condensed abstract is written ONCE, then
		// reused — a temperature-0.3 condense must not churn the card) >
		// deterministic first sentence. The LLM condense fires ONLY when the
		// body exceeds SUMMARY_BODY_BUDGET (leanrag-D6 budget gate), condense is
		// opted in (summaryLlm, tier rule), and no cheaper source exists; on
		// failure it falls back to the clamped deterministic sentence — ingest
		// never blocks on the LLM.
		let summaryText: string | undefined;
		if (rec.summary && rec.summary.trim()) {
			summaryText = clampSummary(rec.summary);
		} else if (existing.has(p.basename)) {
			summaryText = readCardSummary(p.abs);
		} else if (rec.detail.trim()) {
			const deterministic = firstSentenceSummary(rec.detail);
			if (rec.detail.length <= SUMMARY_BODY_BUDGET || dryRun || !summaryLlm) {
				// Short body, a dry-run probe, or condense not opted in — the
				// deterministic clamped sentence is the L0 abstract.
				summaryText = deterministic;
			} else {
				// Over budget + opted in: LLM condense (D4 budget gate). Never
				// blocks ingest — the clamped deterministic sentence is the
				// failure floor.
				const condensed = await condenseSummary(rec.detail, {
					_fetchImpl: opts._summaryFetch,
				});
				summaryText = condensed ?? deterministic;
			}
		}
		if (summaryText) rec = { ...rec, summary: summaryText };
		const content = renderCard(
			rec,
			created,
			tags,
			links,
			opts.sourceLabel,
			maxDetailChars,
			entities,
			relations,
		);

		// Validate frontmatter-only (no idx → no dead-link false-positives mid-batch).
		const v = validateZettelNote(content);
		if (!v.ok) {
			summary.skipped++;
			summary.parseErrors.push({
				line: 0,
				reason: `card for ${rec.id} failed zettel validation: ${v.errors.join("; ")}`,
			});
			continue;
		}
		if (Buffer.byteLength(content, "utf8") > ZETTEL_MAX_BYTES) {
			summary.skipped++;
			summary.parseErrors.push({
				line: 0,
				reason: `card for ${rec.id} exceeds ${ZETTEL_MAX_BYTES / 1024}KB`,
			});
			continue;
		}

		let outcome: CardOutcome;
		const existedBefore = existing.has(p.basename);
		if (dryRun) {
			// Dry-run is a TRUE idempotency probe: for an existing card, compare the
			// would-be content against the on-disk content so a re-ingest reports
			// `unchanged` (not a conservative `updated`) when nothing changed.
			if (existedBefore) {
				try {
					outcome = readFileSync(p.abs, "utf8") === content ? "unchanged" : "updated";
				} catch {
					outcome = "updated";
				}
			} else {
				outcome = "created";
			}
		} else if (!existedBefore) {
			writeFileSync(p.abs, content, "utf8");
			outcome = "created";
		} else {
			const prev = readFileSync(p.abs, "utf8");
			if (prev === content) {
				outcome = "unchanged";
			} else {
				writeFileSync(p.abs, content, "utf8");
				outcome = "updated";
			}
		}
		summary[outcome === "created" ? "created" : outcome === "updated" ? "updated" : "unchanged"]++;
		summary.linked += links.length;
		summary.cards.push({ id: rec.id, path: p.rel, status: outcome, links: links.length });
	}

	// 5. Regenerate the MOC from every card now in the folder (post-write).
	if (!dryRun || existsSync(folderAbs)) {
		const allCards = existsSync(folderAbs)
			? readdirSync(folderAbs)
					.filter((n) => n.endsWith(".md"))
					.map((n) => join(folderAbs, n))
			: [];
		if (allCards.length > 0) {
			summary.mocUpdated = writeMoc(opts.vaultPath, mocPath, allCards, dryRun);
		}
	}

	// 6. Post-write index rebuild (ticket 08 fold-back, ticket 10
	//    reconciliation): after the MOC regeneration, fingerprint-gated +
	//    coalesced, fire-and-forget. Opt-in (`indexRebuild: true`,
	//    production callers only — a rebuild touches the live Surreal
	//    service); any failure is non-fatal — the D36 freshness gate serves
	//    flat until the next successful rebuild.
	if (!dryRun && opts.indexRebuild === true) {
		scheduleCardRebuild({ vaultPath: opts.vaultPath, folder });
	}

	return summary;
}

/** Human-readable summary for CLI / tool output. */
export function formatSummary(s: IngestSummary): string {
	const rel = (p: string) => relative(s.vaultPath, join(s.vaultPath, p));
	const head = [
		`vault:   ${s.vaultPath}`,
		`folder:  ${rel(s.folder)}/`,
		`source:  ${s.source} (${s.sourceLabel})`,
		`total:   ${s.total} record(s) → ${s.created} created, ${s.updated} updated, ${s.unchanged} unchanged, ${s.skipped} skipped${s.wikiMerged > 0 ? `, ${s.wikiMerged} wiki-merged` : ""}${s.semanticMerged > 0 || s.semanticSkipped > 0 ? `, ${s.semanticMerged} semantic-merged, ${s.semanticSkipped} semantic-skipped` : ""}`,
		`links:   ${s.linked} cross-source edge(s) written`,
		`moc:     ${s.mocUpdated ? "regenerated " + rel("Tags/Knowledge Graph.md") : "(no MOC change)"}`,
	];
	if (s.parseErrors.length > 0) {
		head.push("", `parse errors (${s.parseErrors.length}):`);
		for (const e of s.parseErrors.slice(0, 12))
			head.push(`  line ${e.line}: ${e.reason}`);
		if (s.parseErrors.length > 12) head.push(`  …(+${s.parseErrors.length - 12} more)`);
	}
	return head.join("\n");
}
