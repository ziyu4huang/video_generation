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
 * (T5(b) hermes-local cosine cache + T4 dedup depth-pass are deferred —
 * follow-up tickets.)
 */

import type { MemoryRepository } from "./repository.js";
import type { KnowledgePipeline, RetrieveResult } from "@repo/pi-agent-ext-core-interface";
import type { VectorStore, VectorKnnHit } from "./surreal/vector-store.js";
import { embedQuery, type Embedder } from "./surreal/embedder.js";

/** The card "kind" namespace. Mirrors zk's knowledge folder vs hermes memory. */
export type SemanticKind = "memory" | "knowledge";

export interface SemanticSearchHit {
  mdId: string;
  kind: SemanticKind;
  /** Optional relevance score (HNSW returns none; lexical/cosine fallbacks may). */
  score?: number;
  /** Which path produced this hit — useful for tracing the fallback decision. */
  source: "hnsw" | "zk-semantic" | "memory-lexical";
  /** Content hash surfaced from card_vectors on the warm (HNSW) path — the
   *  redundancy-aware dedup key (ticket 19). Optional: the cold fallback paths
   *  (memory-lexical / zk-semantic) do not carry it, so do not assume present. */
  contentHash?: string;
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
  const {
    queryText, kind, topK = 10, ef = 100, model, embedder,
    vectorStore, memoryRepo, kp, vaultPath, folder, excludeIds,
    scheduleVectorBackfill, survivingK,
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
          const rows = await vectorStore.knn(qvec, topK, ef);
          const hits = rows.map((r) => toHit(r, kind));
          const seen = new Set<string>();
          const ranked: SemanticSearchHit[] = [];
          for (const h of hits) {
            if (exclude.has(h.mdId)) continue;
            if (kind && h.kind !== kind) continue;
            if (seen.has(h.mdId)) continue;
            seen.add(h.mdId);
            ranked.push(h);
            if (ranked.length >= topK) break;
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
          // Ticket 19 T2: redundancy-aware contentHash dedup seam. Applied to
          // the warm (HNSW) ranked list before the early return — the SAME
          // private pass the cold fallbacks use below. hashless hits are kept,
          // duplicate contentHashes collapse to the first occurrence. dedup can
          // only shrink a non-empty list (it keeps the first per key), so
          // `deduped.length === 0` ⟺ `ranked.length === 0` — the cold-index
          // trigger signal is preserved.
          const deduped = dedupByContentHash(ranked);
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
    : await memoryFallback(queryText, memoryRepo, exclude, topK, cap);
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
    return dedupByContentHash(hits).slice(0, cap);
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
): Promise<SemanticSearchHit[]> {
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
    return dedupByContentHash(hits).slice(0, cap);
  } catch {
    return []; // lexical search threw → empty (never propagates)
  }
}
