/**
 * src/store/surreal/vector-store-helpers.ts — SurrealQL formatting helpers for
 * the card_vectors HNSW side-table (ticket 14 phase A).
 *
 * `vstr` + `VEC_BATCH` are ported VERBATIM from `bench/hnsw-vs-cosine.ts`
 * (ticket 16 — proven against SurrealDB v3.2.3). Centralised here so both the
 * runtime `SurrealVectorStore` and any future bench share one source of truth.
 */

/** SurrealDB's /sql endpoint caps the request body at exactly 1MiB (1,048,576B
 *  — empirically pinned in ticket 16). At 768-dim that caps a single /sql body
 *  at ~143 CREATE/UPSERT statements; 120 gives a safe worst-case margin
 *  (~900KB even if every component renders as a 9-char "-0.XXXXXX"). Build time
 *  is HNSW-graph-bound, not RTT-bound, so the smaller batch costs negligible
 *  wall time. */
export const VEC_BATCH = 120;

/** Compact SurrealQL array literal for a vector (6 decimals ≈ f32 precision).
 *  Verbatim from bench/hnsw-vs-cosine.ts. Renders `[x.toFixed(6),...]`. */
export function vstr(v: number[]): string {
  let s = "[";
  for (let i = 0; i < v.length; i++) {
    if (i) s += ",";
    s += v[i].toFixed(6);
  }
  return s + "]";
}
