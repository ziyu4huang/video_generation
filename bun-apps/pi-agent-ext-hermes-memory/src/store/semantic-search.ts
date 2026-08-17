/**
 * @upstream(LeanRAG) concept ④ (warm vector-ANN retrieval) + concept ③
 * (redundancy-aware context — PORTING via ticket 19).
 * The lazy embed → HNSW warm path (+ zk-cosine / lexical-FTS cold fallback,
 * ticket 14 T5a) is LeanRAG's retrieval entry point. Ticket 19 ports LeanRAG
 * concept ③ here: frequency-voted card recall + exact-contentHash dedup on both
 * warm and cold paths. See ADR-0001, ticket 19, docs/LEANRAG-PROVENANCE.md.
 *
 * src/store/semantic-search.ts — T2 semantic search spine + T5(a) graceful
 * fallback (ticket 14 phase A).
 *
 * Warm path (T2): embed the query → VectorStore.knn (HNSW) → ranked mdIds.
 *
 * Graceful degrade (T5a): if the query can't be embedded (LM Studio down /
 * model missing) OR the VectorStore throws / is unwired (SurrealDB down), the
 * search NEVER throws — it falls back to the best available lexical path:
 *   - knowledge cards → zk's cosine cache via the KnowledgePipeline seam
 *     (`kp.retrieveRecords({semantic:true, queryText, semanticModel})`);
 *   - memory cards → the existing lexical `memoryRepo.searchMemories` (FTS).
 * Both fallbacks return results; a total failure returns [].
 *
 * Why this shape: SurrealDB is an OPTIONAL side-table (default CRUD is SQLite —
 * sqlite-vec not loadable under Bun). Semantic search must therefore degrade
 * to the existing deterministic lexical arc whenever the vector store is cold,
 * down, or unwired, with byte-identical parity to the pre-semantic baseline.
 *  T5(b) SHIPPED (kp18 / hermes-arch 10): hermes-cosine over the local
 *  card-vectors-cache.json mirror, embedModel-guarded. T4 dedup depth-pass
 *  remains deferred.
 * follow-up tickets.)
 */

import type { MemoryRepository } from "./repository.js";
import type { KnowledgePipeline, RetrieveResult } from "@repo/pi-agent-core-interface";
import type { VectorStore, VectorKnnHit } from "./surreal/vector-store.js";
import { embedQuery, type Embedder } from "@repo/pi-agent-core-interface";
import { normalizeRelation } from "./relation-schema.js";
import { DEFAULT_BOOST_WEIGHT } from "../constants.js";
import { loadCardVectorsCache, cosineSimilarity } from "./card-vectors-cache.js";

/** The card "kind" namespace. Mirrors zk's knowledge folder vs hermes memory. */
export type SemanticKind = "memory" | "knowledge";

export interface SemanticSearchHit {
  mdId: string;
  kind: SemanticKind;
  /** Optional relevance score (HNSW returns none; lexical/cosine fallbacks may). */
  score?: number;
  /** Which path produced this hit — useful for tracing the fallback decision. */
  source: "hnsw" | "zk-semantic" | "memory-lexical" | "hermes-cosine";
  /** Content hash surfaced from card_vectors on the warm (HNSW) path — the
   *  redundancy-aware dedup key (ticket 19). Optional: the cold fallback paths
   *  (memory-lexical / zk-semantic) do not carry it, so do not assume present. */
  contentHash?: string;
  /** Graph relations attached on the warm path via the batched `fetchRelations`
   *  seam (ticket 03 P2-T5, LeanRAG ③) — the second redundancy-aware dedup key.
   *  Optional, mirroring `contentHash`: absent when the seam is unwired, the
   *  card/graph is missing, or the lookup failed (silent skip — never blocks
   *  search). Cold fallback paths never carry it. */
  relations?: SemanticRelation[];
  /** Ticket 20 T1: how many independent recall signals surfaced this card —
 *  1 (warm HNSW) + number of extra signal seams (lexicalRecall /
 *  entityRecall) whose lists contain the mdId. Observability only. Set ONLY
 *  when at least one signal seam was invoked on the warm path; fallback-path
 *  hits and seam-less searches leave it undefined. */
  signalCount?: number;
}

/** A typed graph relation triple (mirrors CardGraph.relations, ticket 03). */
export interface SemanticRelation {
  s: string;
  rel: string;
  o: string;
}

export interface SearchSemanticOptions {
  queryText: string;
  /** Restrict to one kind. When omitted, the warm HNSW path returns whatever
   *  kinds are indexed (mixed); the fallback paths pick by `kind` (default
   *  "memory"). */
  kind?: SemanticKind;
  /** K for the KNN query (default from config / 10). */
  topK?: number;
  /** Cap on the post-dedup returned list (ticket 19 T3). When unset, defaults
   *  to `topK` so existing behavior is unchanged. A CAP not a refill — applied
   *  AFTER contentHash dedup on every return path. */
  survivingK?: number;
  /** HNSW ef (default from config / 100). */
  ef?: number;
  /** Embedding model id (default nomic-embed-text-v1.5). */
  model?: string;
  /** kp18 T5b (hermes-arch 10): memory dir holding `card-vectors-cache.json`.
   *  When set AND a query vector exists, the memory cold path tries local
   *  cosine over the hermes-side mirror BEFORE the lexical floor (SurrealDB
   *  down degrade). Absent → behavior unchanged (lexical only). */
  memoryDir?: string;
  /** Injectable embedder (default: constructed by the caller from config). */
  embedder?: Embedder;
  /** The HNSW vector store (warm path). Undefined → skip straight to T5(a). */
  vectorStore?: VectorStore;
  /** Memory repo for the lexical fallback (memory kind). */
  memoryRepo?: Pick<MemoryRepository, "searchMemories">;
  /** zk's KnowledgePipeline seam for the knowledge-card cosine fallback. */
  kp?: KnowledgePipeline;
  /** zk retrieve options the fallback needs (vaultPath + folder). Required for
   *  the knowledge fallback; ignored otherwise. */
  vaultPath?: string;
  folder?: string;
  /** Exclude these mdIds/card ids from the result set (mirrors zk excludeIds). */
  excludeIds?: string[];
  /** Phase B / T3: best-effort cold-index vector backfill trigger. The caller
   *  closes over the live cardStore/vectorStore/embedder/config and passes a
   *  zero-arg trigger (typically `() => scheduleVectorBackfill(...)`). Fired
   *  fire-and-forget when the warm path returns EMPTY (the cold-index signal);
   *  the backfill's own inProgress guard coalesces cold-query bursts so at most
   *  one backfill runs at a time. Never awaited — never blocks the query. */
  scheduleVectorBackfill?: () => void;
  /** Ticket 03 P2-T5 (LeanRAG ③): batched card-graph relations lookup for the
   *  WARM path. Given the surviving hit mdIds, resolves mdId → graph.relations
   *  (SQLite `memories.graph` JSON via the caller's card-store access — one
   *  batched query, never N+1). Absent / throwing / missing-card → silent
   *  skip: no relations attached, hit kept. Never fails search. Ignored on the
   *  cold fallback paths (no new fetch machinery there). */
  fetchRelations?: (mdIds: string[]) => Promise<Map<string, SemanticRelation[]>>;
  /** Ticket 20 T1: lexical recall signal (SQLite FTS membership over knowledge
 *  cards). Injected seam, fetchRelations pattern: given the query text and
 *  topK, resolves that signal's own ranked list (rank = 0-based position in
 *  the SIGNAL's list, not the warm list). Silent-skip contract: absent /
 *  throwing / empty → that signal simply does not vote. Warm path only.
 *  Production builder lands in ticket 20 T3 (knowledge-search-tool). */
  lexicalRecall?: (queryText: string, topK: number) => Promise<Array<{ mdId: string; rank: number }>>;
  /** Ticket 20 T1: entity recall signal (query-side dictionary extraction ×
 *  card graph.entities scan). Same injected-seam shape and silent-skip
 *  contract as `lexicalRecall`. Warm path only. */
  entityRecall?: (queryText: string, topK: number) => Promise<Array<{ mdId: string; rank: number }>>;
  /** Ticket 20 T1: dominance weight of the multi-signal frequency vote
 *  (PINNED formula: final = (signalCount - 1) * boostWeight + bestRankScore).
 *  Default 1.0 (at default, any 2-signal card outranks any 1-signal card —
 *  rank score ≤ 1). Threaded from `config.boostWeight` via the
 *  knowledge-search wiring (T2); DEFAULT_BOOST_WEIGHT lives in constants.ts. */
  boostWeight?: number;
}

/** Internal: normalize a VectorKnnHit to a SemanticSearchHit (warm path). */
function toHit(h: VectorKnnHit, kind: SemanticKind | undefined): SemanticSearchHit {
  // The store carries `kind` per row; honor it when present and valid, else
  // fall back to the caller's requested kind.
  const k: SemanticKind = h.kind === "knowledge" ? "knowledge" : h.kind === "memory" ? "memory" : (kind ?? "memory");
  // Surface contentHash only when the knn row provided it, so hashless warm
  // hits stay shape-compatible (ticket 19 warm-path dedup key).
  // Fix 1 (final review): only set when truthy (null/"" treated as "no key").
  const hit: SemanticSearchHit = { mdId: h.mdId, kind: k, source: "hnsw", score: h.score };
  if (h.contentHash) hit.contentHash = h.contentHash;
  return hit;
}

/**
 * Redundancy-aware dedup pass (ticket 19 T2). Keeps the FIRST occurrence per
 * DEFINED contentHash; hits whose contentHash is undefined are ALWAYS kept (a
 * missing contentHash is never a shared key — Global Constraint). Applied on
 * every return path of `searchSemantic` so the warm (HNSW) and cold
 * (zk-semantic / memory-lexical) hits both pass through ONE seam. On the cold
 * paths every hit is hashless (RetrievedCard / MemoryEntry carry no hash), so
 * the pass is a correct no-op there — the meaningful collapse lives on the
 * warm path. Single pure pass: this function only deduplicates (no cap, no
 * boostWeight). The survivingK cap is applied by the CALLER after this pass
 * (Task 3); boostWeight remains deferred (ticket 20 — YAGNI). Never throws.
 */
function dedupByContentHash(hits: SemanticSearchHit[]): SemanticSearchHit[] {
  const seen = new Set<string>();
  const out: SemanticSearchHit[] = [];
  for (const h of hits) {
    // Fix 1 (final review): treat falsy contentHash (undefined/null/"") as "no key".
    // Prevents over-collapse when corrupt rows or ?? "" normalization create
    // shared falsy keys. Only non-empty strings are real dedup keys.
    if (!h.contentHash) {
      out.push(h); // falsy hash → always kept (never a dedup key)
      continue;
    }
    if (seen.has(h.contentHash)) continue; // duplicate hash → drop later twin
    seen.add(h.contentHash);
    out.push(h);
  }
  return out;
}

/**
 * Canonical relation-signature key (ticket 03 P2-T5, LeanRAG ③). For a
 * non-empty, well-formed array: each triple is normalized (`s`/`o` trimmed +
 * lowercased, `rel` through `normalizeRelation` so alias variants like `ref` /
 * `references` and case differences collapse onto one key), the rendered
 * triples are sorted (order-insensitive) and joined `";"` → signature string.
 * Empty / undefined / malformed (non-array, non-object entries, missing
 * fields) → `null` — a null signature is NEVER a dedup key. Never throws:
 * every access is guarded.
 */
function relationSignature(relations: SemanticSearchHit["relations"]): string | null {
  if (!Array.isArray(relations) || relations.length === 0) return null;
  const parts: string[] = [];
  for (const r of relations) {
    if (!r || typeof r !== "object") return null; // malformed entry → no signature
    const s = typeof r.s === "string" ? r.s.trim().toLowerCase() : "";
    const rel = typeof r.rel === "string" ? normalizeRelation(r.rel) : "";
    const o = typeof r.o === "string" ? r.o.trim().toLowerCase() : "";
    if (!s || !rel || !o) return null; // missing/blank field → no signature
    parts.push(`${s}->${rel}->${o}`);
  }
  parts.sort(); // order-insensitive: same edge set ⇒ same signature
  return parts.join(";");
}

/**
 * Ticket 20 T1: multi-signal frequency VOTE + re-rank (LeanRAG concept ③).
 * Pure, never throws. Per-signal scores are mutually incomparable (HNSW
 * cosine vs FTS membership-recency vs entity match-count), so the vote is
 * rank/membership-based ONLY — never cross-signal score arithmetic.
 *
 * For each warm hit:
 *   signalCount    = 1 (warm) + number of signal maps containing the mdId;
 *   bestRankScore  = max over CONTAINING signals of (1 - rank/(topK+1)),
 *                    0 when no signal contains the mdId;
 *   final          = (signalCount - 1) * boostWeight + bestRankScore  [PINNED].
 *
 * Stable sort desc by final — ties keep the original warm (cosine) order.
 * A signal mdId NOT present among the warm hits is ignored (only warm hits
 * are re-ranked; a cold-only signal match cannot be scored against cosine).
 * Mutates nothing structurally: sets `hit.signalCount` on every hit and
 * returns them in voted order (same hit objects, same length).
 */
function voteAndRank(
  hits: SemanticSearchHit[],
  signals: Array<Map<string, number>>,
  boostWeight: number,
  topK: number,
): SemanticSearchHit[] {
  const scored = hits.map((hit, index) => {
    let containing = 0;
    let best = 0;
    for (const signal of signals) {
      const rank = signal.get(hit.mdId);
      if (rank === undefined) continue;
      containing++;
      const score = 1 - rank / (topK + 1);
      if (score > best) best = score;
    }
    const signalCount = 1 + containing;
    return { hit, index, signalCount, final: containing * boostWeight + best };
  });
  scored.sort((a, b) => b.final - a.final || a.index - b.index); // stable via index tie-break
  return scored.map((s) => {
    s.hit.signalCount = s.signalCount; // observability (set whenever a seam was invoked)
    return s.hit;
  });
}

/**
 * Ticket 03 P2-T5 (LeanRAG ③): relation-signature dedup pass — sibling to
 * `dedupByContentHash` with identical keep-first semantics. Keeps the FIRST
 * occurrence per non-null canonical `relationSignature`; hits whose signature
 * is null (no relations / malformed) are ALWAYS kept (a missing signature is
 * never a shared key, mirroring the falsy-hash rule). Applied AFTER the
 * contentHash pass and BEFORE the survivingK cap on every return path; the
 * cold fallback hits are relation-less → correct no-op there. Never throws
 * (all access guarded inside `relationSignature`).
 */
function dedupByRelation(hits: SemanticSearchHit[]): SemanticSearchHit[] {
  const seen = new Set<string>();
  const out: SemanticSearchHit[] = [];
  for (const h of hits) {
    const sig = relationSignature(h.relations); // null ⇒ never a dedup key
    if (sig === null) {
      out.push(h);
      continue;
    }
    if (seen.has(sig)) continue; // identical canonical edges → drop later twin
    seen.add(sig);
    out.push(h);
  }
  return out;
}

/**
 * T2 + T5(a): semantic search with graceful degradation. NEVER throws.
 *
 * Order of operations:
 *   1. If a vectorStore is wired, embed the query (embedQuery swallows errors
 *      → null). On a non-null vector, run knn (warm path). On success, return
 *      the ranked hits (filtered by excludeIds + topK).
 *   2. On ANY failure in step 1 (no vectorStore, embed returned null, knn
 *      threw), fall through to T5(a):
 *        - knowledge kind → kp.retrieveRecords({semantic:true, queryText,
 *          semanticModel}) (zk cosine cache via the seam);
 *        - memory kind (default) → memoryRepo.searchMemories (lexical FTS).
 *      Both are best-effort; a throw is swallowed → [].
 *   3. The result is always a normalized ranked list (deduped by mdId).
 */
export async function searchSemantic(opts: SearchSemanticOptions): Promise<SemanticSearchHit[]> {
  let warmQueryVec: number[] | null = null;
  const {
    queryText, kind, topK = 10, ef = 100, model, embedder,
    vectorStore, memoryRepo, kp, vaultPath, folder, excludeIds,
    scheduleVectorBackfill, survivingK, fetchRelations, memoryDir,
    lexicalRecall, entityRecall, boostWeight,
  } = opts;
  const exclude = new Set(excludeIds ?? []);
  const modelId = model ?? "text-embedding-nomic-embed-text-v1.5";
  // Ticket 19 T3: survivingK caps the post-dedup returned list. Defaults to
  // topK when unset so existing behavior is UNCHANGED (a CAP not a refill).
  // Fix 2 (final review): clamp to avoid JS slice footgun (negative drops last).
  const cap = Math.max(0, survivingK ?? topK);

  // ── Warm path (T2): embed → knn ──────────────────────────────────────────
  if (vectorStore && embedder) {
    try {
      const qvec = await embedQuery(queryText, { model: modelId, embedder });
      if (qvec) {
        try {
          warmQueryVec = qvec;
          const rows = await vectorStore.knn(qvec, topK, ef);
          const hits = rows.map((r) => toHit(r, kind));
          // Ticket 20 T1: multi-signal frequency vote — WARM PATH ONLY, after
          // the knn rank loop and BEFORE fetchRelations + dedup + cap (vote
          // ordering determines which contentHash twin survives dedup and
          // which hits survive the survivingK cap). Either seam present →
          // consult BOTH concurrently via allSettled (a rejected signal is
          // silently skipped — never breaks search); absent seams contribute
          // an empty signal and never vote. Only warm hits are re-ranked;
          // signal mdIds outside the warm set are ignored inside voteAndRank.
          const seen = new Set<string>();
          let ranked: SemanticSearchHit[] = [];
          for (const h of hits) {
            if (exclude.has(h.mdId)) continue;
            if (kind && h.kind !== kind) continue;
            if (seen.has(h.mdId)) continue;
            seen.add(h.mdId);
            ranked.push(h);
            if (ranked.length >= topK) break;
          }
          // ── Ticket 20 T1: frequency vote seam (warm path only) ─────────────
          if (lexicalRecall || entityRecall) {
            const settled = await Promise.allSettled([
              lexicalRecall?.(queryText, topK) ?? [],
              entityRecall?.(queryText, topK) ?? [],
            ]);
            const signalMaps: Array<Map<string, number>> = [];
            for (const outcome of settled) {
              if (outcome.status !== "fulfilled") continue; // rejected signal → skipped
              const map = new Map<string, number>();
              for (const item of outcome.value ?? []) {
                // guard against malformed provider rows — never throws.
                // NaN/Infinity ranks pass the typeof check and still contribute
                // signalCount, but their score never wins (NaN/−Inf > best is
                // false) → effectively 0 score. By design.
                if (item && typeof item.mdId === "string" && typeof item.rank === "number") {
                  map.set(item.mdId, item.rank);
                }
              }
              signalMaps.push(map);
            }
            // boostWeight seam guard (mirrors the config finite->0 floor):
            // NaN/Infinity/<=0 falls back to the default.
            ranked = voteAndRank(
              ranked, signalMaps,
              boostWeight !== undefined && Number.isFinite(boostWeight) && boostWeight > 0 ? boostWeight : DEFAULT_BOOST_WEIGHT,
              topK,
            );
          }
          // A warm path that returned NOTHING is not necessarily a failure,
          // but a cold index returning [] is indistinguishable from "no match".
          // Return the (possibly empty) ranked list — the caller decides. We do
          // NOT fall through on empty, because the warm path answering [] is a
          // legitimate "no semantic match" (falling through would double-search).
          //
          // Phase B / T3 cold-index trigger: an empty warm result is the cold
          // signal — fire the deferred vector backfill best-effort (never
          // awaited, never blocks). The backfill's inProgress guard coalesces
          // cold-query bursts so at most one backfill runs at a time; its
          // deferred task re-checks the staleness delta and embeds only
          // changed/new cards (cheap no-op when the index is already warm).
          // Ticket 03 P2-T5 (LeanRAG ③): attach each surviving hit's card
          // graph relations via the BATCHED `fetchRelations` seam (one lookup
          // for the whole ranked list — never N+1). Silent-skip contract: seam
          // absent / lookup throwing / mdId missing from the map → no
          // relations attached, hit kept. This must NEVER break search.
          if (fetchRelations && ranked.length > 0) {
            try {
              const relMap = await fetchRelations(ranked.map((h) => h.mdId));
              if (relMap) {
                for (const h of ranked) {
                  const rels = relMap.get(h.mdId);
                  if (Array.isArray(rels) && rels.length > 0) h.relations = rels;
                }
              }
            } catch {
              // best-effort graph attach — relations stay absent, hits unchanged
            }
          }
          // Ticket 19 T2: redundancy-aware contentHash dedup seam. Applied to
          // the warm (HNSW) ranked list before the early return — the SAME
          // private pass the cold fallbacks use below. hashless hits are kept,
          // duplicate contentHashes collapse to the first occurrence. dedup can
          // only shrink a non-empty list (it keeps the first per key), so
          // `deduped.length === 0` ⟺ `ranked.length === 0` — the cold-index
          // trigger signal is preserved.
          const deduped = dedupByRelation(dedupByContentHash(ranked));
          if (deduped.length === 0 && scheduleVectorBackfill) {
            try {
              scheduleVectorBackfill();
            } catch {
              // best-effort — never affect the query result
            }
          }
          // Ticket 19 T3: cap the post-dedup list to survivingK (default topK).
          // Applied AFTER dedup so the cold-index trigger signal (deduped===[])
          // is preserved; a non-empty deduped list is sliced down to the cap.
          return deduped.slice(0, cap);
        } catch {
          // knn threw (SurrealDB down / index error) → fall through to T5(a).
        }
      }
      // qvec null (LM Studio down / model missing) → fall through to T5(a).
    } catch {
      // embedder itself threw unexpectedly → fall through to T5(a).
    }
  }

  // ── T5(a) graceful degrade ───────────────────────────────────────────────
  const resolvedKind: SemanticKind = kind ?? "memory";
  return resolvedKind === "knowledge"
    ? await knowledgeFallback(queryText, modelId, kp, vaultPath, folder, exclude, topK, cap)
    : await memoryFallback(
        queryText,
        memoryRepo,
        exclude,
        topK,
        cap,
        memoryDir && warmQueryVec ? { qvec: warmQueryVec, embedModel: modelId, memoryDir } : undefined,
      );
}

/** T5(a) knowledge fallback: zk cosine cache via the KnowledgePipeline seam.
 *  Mirrors the existing knowledge-search-tool retrieve path, but with
 *  `semantic:true` so zk uses its JSON-cache cosine arc. Never throws. */
async function knowledgeFallback(
  queryText: string,
  modelId: string,
  kp: KnowledgePipeline | undefined,
  vaultPath: string | undefined,
  folder: string | undefined,
  exclude: Set<string>,
  topK: number,
  cap: number,
): Promise<SemanticSearchHit[]> {
  if (!kp || !vaultPath) return [];
  try {
    const result: RetrieveResult = await kp.retrieveRecords({
      vaultPath,
      folder,
      tags: [],
      queryText,
      semantic: true,
      semanticModel: modelId,
      topK,
    });
    const hits: SemanticSearchHit[] = [];
    const seen = new Set<string>();
    for (const card of result.cards) {
      if (exclude.has(card.id)) continue;
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      hits.push({ mdId: card.id, kind: "knowledge", source: "zk-semantic" });
      if (hits.length >= topK) break;
    }
    // Ticket 19 T2: same dedup seam as the warm path. Cold-path hits carry no
    // contentHash → this is a correct no-op (all kept), but the seam is wired
    // so a future hash-bearing cold source needs no caller change.
    // Ticket 19 T3: cap the post-dedup list to survivingK (default topK).
    // Ticket 03 P2-T5: relation pass after contentHash — zk cards CAN carry
    // relations, so identical-signature twins collapse here too (the pass is
    // relation-less-tolerant: null signature ⇒ kept, never throws).
    return dedupByRelation(dedupByContentHash(hits)).slice(0, cap);
  } catch {
    return []; // zk seam absent / threw → empty (never propagates)
  }
}

/** T5(a) memory fallback: the existing lexical `searchMemories` (FTS). Never
 *  throws. The memory repo's mdId (frontmatter id mirrored onto the row) is the
 *  SemanticSearchHit.mdId; entries without one are skipped (no stable id to
 *  return). */
async function memoryFallback(
  queryText: string,
  memoryRepo: Pick<MemoryRepository, "searchMemories"> | undefined,
  exclude: Set<string>,
  topK: number,
  cap: number,
  cosine?: { qvec: number[]; embedModel: string; memoryDir: string },
): Promise<SemanticSearchHit[]> {
  // kp18 T5b: hermes-side cosine over the JSON vector mirror — the memory
  // degrade when SurrealDB (and its card_vectors) is down but LM Studio is
  // alive. embedModel guard: cosine across embedding models is garbage.
  if (cosine) {
    try {
      const cache = loadCardVectorsCache(cosine.memoryDir);
      const scored: Array<{ mdId: string; s: number }> = [];
      for (const e of cache.values()) {
        if (e.kind !== "memory") continue;
        if (e.embedModel !== cosine.embedModel) continue;
        if (exclude.has(e.mdId)) continue;
        scored.push({ mdId: e.mdId, s: cosineSimilarity(cosine.qvec, e.vec) });
      }
      if (scored.length > 0) {
        scored.sort((a, b) => b.s - a.s);
        const hits: SemanticSearchHit[] = scored.slice(0, topK).map(({ mdId, s }) => ({
          mdId,
          kind: "memory",
          score: s,
          source: "hermes-cosine",
        }));
        return dedupByRelation(dedupByContentHash(hits)).slice(0, cap);
      }
      // empty or model-mismatched cache → fall through to the lexical floor
    } catch {
      // mirror read failed → lexical floor
    }
  }
  if (!memoryRepo) return [];
  try {
    const entries = await memoryRepo.searchMemories(queryText, { limit: topK });
    const hits: SemanticSearchHit[] = [];
    for (const e of entries) {
      const mdId = e.mdId ?? null;
      if (!mdId) continue;
      if (exclude.has(mdId)) continue;
      hits.push({ mdId, kind: "memory", source: "memory-lexical" });
      if (hits.length >= topK) break;
    }
    // Ticket 19 T2: same dedup seam as the warm path (no-op while MemoryEntry
    // carries no contentHash; wired for forward-compat).
    // Ticket 19 T3: cap the post-dedup list to survivingK (default topK).
    // Ticket 03 P2-T5: relation pass after contentHash — memory hits are
    // relation-less (null signature ⇒ kept) → correct no-op, no new fetch
    // machinery on the fallback path.
    return dedupByRelation(dedupByContentHash(hits)).slice(0, cap);
  } catch {
    return []; // lexical search threw → empty (never propagates)
  }
}
