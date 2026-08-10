// src/store/planning-sync-state.ts — pure content-hash + thin sync-state accessors
// for the .planning card mirror (Phase-2 / ticket 09, Tier-1 md-wins drift).
//
// The DB SQL lives on CardStore (getCardMdHash/upsertCardMdHash/deleteCardMdHash,
// implemented in card-store.ts alongside all other memories/card SQL — the single
// SQL home). This module owns the PURE hash function (planningContentHash, reusing
// merge-plan.hashEntry) + the sync-layer wrappers the mirror/sweep/refresh code
// imports. Hash = 16-hex-char sha256 of canonicalCardBytes(card), keyed by Card.id.
import type { Card } from "./card.js";
import type { CardStore } from "./card-store.js";
import { hashEntry } from "./merge-plan.js";

/** See "Canonical byte form" in the plan: stable JSON of {kind, content, frontmatter}
 *  with recursively-sorted keys. Identical cards hash identically; any content or
 *  frontmatter change changes the hash. */
function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortKeysDeep) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    }
    return out as unknown as T;
  }
  return value;
}

function canonicalCardBytes(card: Card): string {
  return JSON.stringify({
    kind: card.kind,
    content: card.content,
    frontmatter: sortKeysDeep(card.frontmatter),
  });
}

/** Content-hash of a planning card (reuses merge-plan.hashEntry: sha256 → 16 hex). */
export function planningContentHash(card: Card): string {
  return hashEntry(canonicalCardBytes(card));
}

/** Read the stored mirror hash for a card, or null when none has been written. */
export async function getStoredHash(
  store: CardStore,
  cardId: string,
): Promise<{ hash: string; mirroredAt: string; kind: string } | null> {
  return store.getCardMdHash(cardId);
}

/** UPSERT the mirror hash for a card (default kind='mirror'; 10 uses 'validated'). */
export async function upsertHash(
  store: CardStore,
  cardId: string,
  hash: string,
  kind = "mirror",
): Promise<void> {
  await store.upsertCardMdHash(cardId, hash, kind);
}

/** Delete the hash row for a card (paired with hard-delete of the memories row). */
export async function deleteHash(store: CardStore, cardId: string): Promise<void> {
  await store.deleteCardMdHash(cardId);
}
