/**
 * MemoryDedupStrategy — the `DedupStrategy` for kinds memory/user/failure.
 *
 * Composes the EXISTING dedup primitives — no logic is reinvented:
 *  1. exact stripped-equality (mirror `MemoryStore.dedupNormalize`: trim +
 *     collapse whitespace);
 *  2. near-dup containment (`near-dup.ts findNearDuplicate`, threshold
 *     `DEFAULT_NEAR_DUP_THRESHOLD = 0.6`);
 *  3. topic recurrence (`topic-key.ts findTopicRecurrence` + the existing
 *     `formatTopicRecurrenceWarning`).
 *
 * Wired behind `DedupStrategy.dedup` so the store's single dedup call-site
 * delegates here for memory kinds (Task 5). `Card.content` is already the body
 * (no metadata envelope), so normalization is just trim + whitespace-collapse.
 */

import type { Card } from "./card.js";
import type { DedupDecision, DedupStrategy } from "./dedup-strategy.js";
import { findNearDuplicate } from "./near-dup.js";
import { findTopicRecurrence, formatTopicRecurrenceWarning } from "./topic-key.js";

type MemoryKind = "memory" | "user" | "failure";

/** Normalize for exact comparison — mirror `MemoryStore.dedupNormalize` minus
 *  the metadata-strip (a Card's content IS the body). */
function dedupNormalize(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export class MemoryDedupStrategy implements DedupStrategy<MemoryKind> {
  readonly kind: MemoryKind = "memory";

  dedup(incoming: Card, existing: Card[]): DedupDecision {
    const incomingNorm = dedupNormalize(incoming.content);

    // 1. Exact stripped-equality.
    for (const card of existing) {
      if (dedupNormalize(card.content) === incomingNorm) {
        return {
          action: "skip",
          existingId: card.id,
          reason: `exact duplicate of "${card.id}"`,
        };
      }
    }

    const existingContents = existing.map((c) => c.content);

    // 2. Near-dup containment (default threshold DEFAULT_NEAR_DUP_THRESHOLD).
    const near = findNearDuplicate(incoming.content, existingContents);
    if (near) {
      const hit = existing[near.index]!;
      return {
        action: "skip",
        existingId: hit.id,
        reason: `near-duplicate (containment ${near.similarity.toFixed(2)}) of "${hit.id}": ${near.preview}…`,
      };
    }

    // 3. Topic recurrence (warn-don't-block → ask the store to merge).
    const topic = findTopicRecurrence(incoming.content, existingContents);
    if (topic) {
      const hit = existing[topic.index]!;
      return {
        action: "merge",
        existingId: hit.id,
        reason: formatTopicRecurrenceWarning(topic),
      };
    }

    return { action: "keep" };
  }
}
