import type { Card, CardKind } from "./card.js";

/** The single store dedup call-site: given an incoming card and the existing
 *  set of the SAME kind, decide keep / merge / skip. ONE call-site in the store
 *  (no duplication), kind-specific richness preserved by the impl (ticket 01). */
export interface DedupStrategy<K extends CardKind = CardKind> {
  readonly kind: K;
  dedup(incoming: Card, existing: Card[]): DedupDecision;
}

/** The outcome of a dedup check. */
export interface DedupDecision {
  /** `keep` — insert `incoming` as a new card.
   *  `merge` — `incoming` overlaps an existing card; the store merges it into
   *    `existingId` (compose `merge-plan.ts` for memory; upsert evidence for
   *    knowledge — but knowledge `merge` is a 06b concern; 06a returns skip).
   *  `skip` — `incoming` is a duplicate; drop it (the canonical card is
   *    `existingId`). */
  action: "keep" | "merge" | "skip";
  /** Present for `merge`/`skip`: the existing card's `Card.id`. */
  existingId?: string;
  /** Human-readable rationale (surfaced to the agent as the write-time signal). */
  reason?: string;
}
