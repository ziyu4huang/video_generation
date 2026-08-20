// src/store/relation-schema.ts — LeanRAG ③ relation-dedup canonical key.
//
// The knowledge-graph schema is HYBRID (ticket 03 / ADR-0001): a small set of
// CORE relations with stable canonical keys + free-form fallthrough for
// everything else. `normalizeRelation` collapses common aliases of the core 6
// onto their canonical form so query-typing + (Phase-2) `dedupByRelation` can
// match by key. It applies on READ only — relations are stored as-emitted;
// the only write-site that canonicalizes is the serializer write-back, which
// re-emits the already-canonicalized-in-memory `graph.relations` (D3 contract).

/** The canonical core-relation keys (hybrid schema's typed spine). Free-form
 *  predicates are NOT members — they pass through `normalizeRelation` as-is. */
export const CORE_RELATIONS = new Set<string>([
  "references",
  "depends-on",
  "extends",
  "contradicts",
  "supersedes",
  "implements",
]);

/** Common surface aliases of the core 6 → their canonical key. Lowercased +
 *  trimmed by `normalizeRelation` before lookup (so `"Ref"`/`"REF"` also map).
 *  Free-form predicates (e.g. `"uses"`) are absent and pass through unchanged. */
export const RELATION_ALIASES: Record<string, string> = {
  ref: "references",
  refs: "references",
  reference: "references",
  dependson: "depends-on",
  depends_on: "depends-on",
  "depends on": "depends-on",
  extend: "extends",
  extended: "extends",
  contradict: "contradicts",
  supersede: "supersedes",
  implement: "implements",
  implementation: "implements",
};

/** Normalize a relation predicate: lowercase + trim, then alias-map the core 6
 *  onto their canonical key. Free-form predicates pass through unchanged. */
export function normalizeRelation(rel: string): string {
  const k = (rel ?? "").trim().toLowerCase();
  return RELATION_ALIASES[k] ?? k;
}
