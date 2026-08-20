// src/store/planning-dedup.ts — DedupStrategy for planning-cards (Phase-2 / 08).
// Idempotent upsert by Card.id (same shape as KnowledgeDedupStrategy). Planning
// content updates land via ticket 09's content-hash refresh; 08 is append-once.
import type { Card } from "./card.js";
import type { DedupDecision, DedupStrategy } from "./dedup-strategy.js";

export class PlanningEffortDedupStrategy implements DedupStrategy<"planning-effort"> {
  readonly kind = "planning-effort" as const;
  dedup(incoming: Card, existing: Card[]): DedupDecision {
    if (existing.some((c) => c.id === incoming.id)) {
      return { action: "skip", existingId: incoming.id, reason: "idempotent re-ingest (same effort id)" };
    }
    return { action: "keep" };
  }
}

export class PlanningTicketDedupStrategy implements DedupStrategy<"planning-ticket"> {
  readonly kind = "planning-ticket" as const;
  dedup(incoming: Card, existing: Card[]): DedupDecision {
    if (existing.some((c) => c.id === incoming.id)) {
      return { action: "skip", existingId: incoming.id, reason: "idempotent re-ingest (same ticket id)" };
    }
    return { action: "keep" };
  }
}
