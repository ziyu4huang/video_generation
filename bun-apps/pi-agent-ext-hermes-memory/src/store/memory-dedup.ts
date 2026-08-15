/**
 * MemoryDedupStrategy — the `DedupStrategy` for kinds memory/user/failure.
 *
 * kp13 Wave B: memory kinds are md_id-keyed and md is CANONICAL — every §-entry
 * the md layer accepted gets its own card row keyed by its frontmatter id. The
 * md layer (MemoryStore.add) already adjudicates content overlap BEFORE the
 * mirror runs: exact duplicates are refused outright and near-dups/topic
 * recurrence are WARNINGS ONLY ("the entry is still added" — see
 * memory-store.ts). Content-based dropping here would therefore only ever
 * delete rows the md layer deliberately kept — silently unsearchable memories
 * and a non-converging lazy re-migration (the dropped entry is re-attempted
 * on every startup pass).
 *
 * So this strategy is IDENTITY-keyed, not content-keyed:
 *  - an existing card with the SAME id (memories.md_id) → `skip` (identity
 *    guard: upsertCard must never insert a second row for one md_id — the
 *    refresh path is updateCard, which bypasses dedup by design);
 *  - otherwise → `keep` (distinct md_id ⇒ distinct row, mirroring the retired
 *    syncMemoryEntry's exact-identity semantics without its content keying).
 */

import type { Card } from "./card.js";
import type { DedupDecision, DedupStrategy } from "./dedup-strategy.js";

type MemoryKind = "memory" | "user" | "failure";

export class MemoryDedupStrategy implements DedupStrategy<MemoryKind> {
  readonly kind: MemoryKind = "memory";

  dedup(incoming: Card, existing: Card[]): DedupDecision {
    for (const card of existing) {
      if (card.id === incoming.id) {
        return {
          action: "skip",
          existingId: card.id,
          reason: `identity: md_id "${card.id}" is already mirrored`,
        };
      }
    }
    return { action: "keep" };
  }
}
