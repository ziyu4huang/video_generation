/**
 * src/store/surreal/vector-store.ts — HNSW vector side-table for the
 * card_vectors index (ticket 14 phase A / T1).
 *
 * A SIDE-TABLE: lives in its OWN Surreal ns/db, independent of the CRUD
 * backend. The default CRUD backend is SQLite (sqlite-vec is not loadable
 * under Bun — Decision 04 Fork C), so semantic search cannot reuse the CRUD
 * store. This store is the SurrealDB-side home of every embedded memory +
 * knowledge card: upsert (idempotent on mdId+modelVersion), KNN (warm path),
 * and missingMdIds (cold-set diff for lazy backfill).
 *
 * Patterns are ported VERBATIM from `bench/hnsw-vs-cosine.ts` (ticket 16 —
 * proven against SurrealDB v3.2.3): DDL `DEFINE INDEX ... HNSW DIMENSION 768
 * DIST COSINE TYPE F32`, batched upsert (VEC_BATCH=120, /sql 1MiB cap), KNN
 * `SELECT ... WHERE vec <|k,ef|> $q`. The bench used table `v`; we rename to
 * `card_vectors` (defined in VECTOR_BOOTSTRAP_SQL).
 *
 * Idempotency: rows are keyed by a backtick-quoted record id
 * `${mdId}__${modelVersion}` so a re-upsert of the same key overwrites (the
 * `card_vectors_key` index is a lookup aid, NOT the uniqueness enforcer — the
 * deterministic record id is).
 */

import type { SurrealClient } from "./surreal-client.js";
import { VECTOR_BOOTSTRAP_SQL } from "./schema.js";
import { vstr, VEC_BATCH } from "./vector-store-helpers.js";

/** A single memory/knowledge entry to embed+store. */
export interface VectorUpsertEntry {
  /** Stable markdown-side id (mirrors the .md frontmatter id / DB md_id). */
  mdId: string;
  /** "memory" | "knowledge" — the consumer kind, surfaced back by knn(). */
  kind: string;
  /** The 768-dim embedding vector. */
  vec: number[];
  /** Content hash (future cache-invalidation; stored, not yet queried). */
  contentHash: string;
  /** Model-lineage tag (the delta-key component so a model swap re-embeds). */
  modelVersion: string;
}

/** A KNN hit. `score` is optional: SurrealDB's 2-arg KNN returns rows in
 *  nearest-first order but does not return a distance column, so the warm path
 *  leaves score undefined (rank order is the signal); the T5(a) fallback paths
 *  may attach a cosine/lexical score. */
export interface VectorKnnHit {
  mdId: string;
  kind: string;
  score?: number;
}

/** Backend-neutral vector store seam. The non-Surreal case (SQLite CRUD with
 *  no vector index) is a no-op stub — see `createVectorStore`. */
export interface VectorStore {
  /** Create the ns/db + card_vectors table + HNSW index. Idempotent. */
  init(): Promise<void>;
  /** Idempotently upsert embeddings, batched (VEC_BATCH) to respect the /sql
   *  1MiB body cap. Same (mdId, modelVersion) re-upserted must not duplicate. */
  upsertVectors(entries: VectorUpsertEntry[]): Promise<void>;
  /** KNN over card_vectors: nearest mdIds to `queryVec`, in nearest-first
   *  order. Empty store → empty array (never throws on a cold index). */
  knn(queryVec: number[], k: number, ef: number): Promise<VectorKnnHit[]>;
  /** The cold set: mdIds present in `allMdIds` but absent from card_vectors at
   *  `modelVersion` (the lazy-backfill candidate list). */
  missingMdIds(allMdIds: string[], modelVersion: string): Promise<string[]>;
  /** The stored (mdId → contentHash) map for one modelVersion — the staleness
   *  delta source for the T3 background backfill. One body-safe query (returns
   *  hashes, NOT vectors). A card whose stored hash ≠ its current contentHash
   *  (or is absent) is the delta the backfill re-embeds. */
  getStoredHashes(modelVersion: string): Promise<Map<string, string>>;
}

/**
 * Build a backtick-quoted SurrealDB record-id literal for the composite key.
 * The backtick form `` card_vectors:`<key>` `` handles arbitrary chars in
 * mdId (uuids, slashes, dots) — verified against v3.2.3. The key is
 * `${mdId}__${modelVersion}`; re-upsert of the same key overwrites the row
 * (the deterministic record id is the uniqueness enforcer).
 */
function recordId(mdId: string, modelVersion: string): string {
  // A backtick inside mdId would break the literal — escape it. mdIds are
  // uuids/slugs in practice (no backticks), but the guard is cheap and keeps
  // the SQL safe against any input.
  const key = `${mdId}__${modelVersion}`.replace(/`/g, "_");
  return `card_vectors:\`${key}\``;
}

/**
 * SurrealDB-backed `VectorStore`. Constructed over a `SurrealClient` already
 * pointed at the vector ns/db (the caller — e.g. semantic-search / index.ts —
 * owns the client lifecycle, mirroring how SurrealBackend owns the CRUD client).
 */
export class SurrealVectorStore implements VectorStore {
  private initialized = false;
  constructor(
    private readonly client: SurrealClient,
    private readonly ns: string,
    private readonly db: string,
  ) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.client.query(VECTOR_BOOTSTRAP_SQL(this.ns, this.db));
    this.initialized = true;
  }

  async upsertVectors(entries: VectorUpsertEntry[]): Promise<void> {
    await this.init();
    if (entries.length === 0) return;
    // Chunk ≤ VEC_BATCH to respect the /sql 1MiB body cap (768-dim → ~9KB/row;
    // 120×9KB ≈ 1.08MB worst case is under the 1MiB cap with the 6-decimal
    // render used here — see bench/hnsw-vs-cosine.ts SQL_BODY_LIMIT_B note).
    for (let i = 0; i < entries.length; i += VEC_BATCH) {
      const chunk = entries.slice(i, i + VEC_BATCH);
      const stmts: string[] = new Array(chunk.length);
      for (let j = 0; j < chunk.length; j++) {
        const e = chunk[j]!;
        stmts[j] =
          `UPSERT ${recordId(e.mdId, e.modelVersion)} SET mdId = ${JSON.stringify(e.mdId)}, ` +
          `kind = ${JSON.stringify(e.kind)}, modelVersion = ${JSON.stringify(e.modelVersion)}, ` +
          `contentHash = ${JSON.stringify(e.contentHash)}, vec = ${vstr(e.vec)};`;
      }
      await this.client.query(stmts.join("\n"));
    }
  }

  async knn(queryVec: number[], k: number, ef: number): Promise<VectorKnnHit[]> {
    await this.init();
    // 2-arg KNN: `vec <|k,ef|> $q`. $q bound by SurrealClient (LET $q = <json>).
    // SurrealDB returns rows in nearest-first order; no distance column, so
    // score is left undefined (rank order is the signal).
    const sql = `SELECT mdId, kind FROM card_vectors WHERE vec <|${k},${ef}|> $q;`;
    const rows = await this.client.query<Array<{ mdId: string; kind: string }>>(sql, { q: queryVec });
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => ({ mdId: r.mdId, kind: r.kind }));
  }

  async missingMdIds(allMdIds: string[], modelVersion: string): Promise<string[]> {
    await this.init();
    if (allMdIds.length === 0) return [];
    // Client-side set diff (one round-trip): SELECT every stored mdId for the
    // modelVersion, then return the allMdIds NOT in that set. This is
    // DELIBERATELY not `... WHERE mdId NOT IN $ids`: passing allMdIds as a
    // SurrealQL param would put the whole array in the /sql request body, which
    // at scale (~100k mdIds ≈ 1MB) hits the 1MiB body cap. Querying stored
    // mdIds by modelVersion (small param) + diffing client-side is body-safe at
    // any scale and avoids the `NOT array::contains(...)` v3.2.3 parse error.
    const sql = `SELECT mdId FROM card_vectors WHERE modelVersion = $mv;`;
    const rows = await this.client.query<Array<{ mdId: string }>>(sql, { mv: modelVersion });
    const stored = new Set((Array.isArray(rows) ? rows : []).map((r) => r.mdId));
    const missing: string[] = [];
    for (const id of allMdIds) {
      if (!stored.has(id)) missing.push(id);
    }
    return missing;
  }

  async getStoredHashes(modelVersion: string): Promise<Map<string, string>> {
    await this.init();
    // One body-cap-safe query (hashes, not vectors). Returns Map<mdId,
    // contentHash> so the T3 backfill computes the staleness delta client-side:
    // a card is stale iff stored hash ≠ current contentHash (or absent).
    const sql = `SELECT mdId, contentHash FROM card_vectors WHERE modelVersion = $mv;`;
    const rows = await this.client.query<Array<{ mdId: string; contentHash: string }>>(sql, { mv: modelVersion });
    const out = new Map<string, string>();
    for (const r of Array.isArray(rows) ? rows : []) {
      if (r && typeof r.mdId === "string") out.set(r.mdId, r.contentHash ?? "");
    }
    return out;
  }
}

/**
 * No-op `VectorStore` for the non-Surreal case (the default — SQLite CRUD with
 * no vector index). Every method is a graceful no-op / empty result so the
 * caller (semantic-search) falls through to the T5(a) lexical fallback without
 * special-casing. `init()` is a no-op; `knn()` returns []; `upsertVectors` /
 * `missingMdIds` are no-ops/empty. The presence of this stub means the consumer
 * never has to null-check — but `createVectorStore` returns `undefined` for the
 * non-Surreal case so semantic-search can distinguish "no vector store wired"
 * from "vector store wired but empty".
 */
export class NoopVectorStore implements VectorStore {
  async init(): Promise<void> { /* no-op */ }
  async upsertVectors(_entries: VectorUpsertEntry[]): Promise<void> { /* no-op */ }
  async knn(_queryVec: number[], _k: number, _ef: number): Promise<VectorKnnHit[]> { return []; }
  async missingMdIds(_allMdIds: string[], _modelVersion: string): Promise<string[]> { return []; }
  async getStoredHashes(_modelVersion: string): Promise<Map<string, string>> { return new Map(); }
}

/** Factory: build a SurrealVectorStore over an existing client, or `undefined`
 *  when no Surreal client is available (the SQLite-default case). Returning
 *  `undefined` (not a NoopVectorStore) lets semantic-search distinguish "not
 *  wired" from "wired but empty/throwing" and choose the right fallback. */
export function createVectorStore(client: SurrealClient | null | undefined, ns: string, db: string): VectorStore | undefined {
  if (!client) return undefined;
  return new SurrealVectorStore(client, ns, db);
}
