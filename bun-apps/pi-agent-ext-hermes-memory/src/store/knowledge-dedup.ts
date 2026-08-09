/**
 * KnowledgeDedupStrategy — the `DedupStrategy` for kind "knowledge".
 *
 * 06a DECISION (revisitable in 06b): **idempotent upsert by `Card.id`**.
 * zk ALREADY does md-layer merge (wiki-aware convergence at `wikiThreshold` ≈
 * 0.85 token-set Jaccard, ticket 06 fork 1). Store-side semantic dedup for
 * knowledge (cross-card merge when two DIFFERENT canonical ids describe the
 * same lesson) is a real concern but a **06b** concern — 06a only proves the
 * store can HOLD knowledge-cards and round-trip them. Returning `skip` on
 * id-match makes re-ingest idempotent (re-reading the same vault corpus never
 * duplicates rows), which is exactly what the acceptance test needs.
 *
 * Revisit in 06b: a richer `KnowledgeDedupStrategy` (wiki-aware merge à la zk)
 * can replace this WITHOUT touching the call-site — the whole point of the
 * strategy seam. See spec §6.
 */

import type { Card } from "./card.js";
import type { DedupDecision, DedupStrategy } from "./dedup-strategy.js";

export class KnowledgeDedupStrategy implements DedupStrategy<"knowledge"> {
  readonly kind = "knowledge" as const;

  dedup(incoming: Card, existing: Card[]): DedupDecision {
    const hit = existing.find((c) => c.id === incoming.id);
    if (hit) {
      return {
        action: "skip",
        existingId: incoming.id,
        reason: "idempotent re-ingest (same canonical id)",
      };
    }
    return { action: "keep" };
  }
}
