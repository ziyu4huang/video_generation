// src/store/planning-sync-state.ts — pure content-hash + thin sync-state accessors
// for the .planning card mirror (Phase-2 / ticket 09, Tier-1 md-wins drift).
//
// The DB SQL lives on CardStore (getCardMdHash/upsertCardMdHash/deleteCardMdHash,
// implemented in card-store.ts alongside all other memories/card SQL — the single
// SQL home). This module owns the PURE hash function (planningContentHash, reusing
// merge-plan.hashEntry) + the sync-layer wrappers the mirror/sweep/refresh code
// imports. Hash = 16-hex-char sha256 of canonicalCardBytes(card), keyed by Card.id.
//
// Freshness model (T6/T7): regular reads — CardStore.getCard / getCardsByKind —
// return the DB row AS-IS (fast; NO re-hash, NO re-read of source md). Planning
// freshness is provided by exactly two mechanisms, NEVER an every-read-rehash:
//   1. the T6 background backfill on session_start (best-effort, non-blocking), and
//   2. the T7 on-demand refreshPlanningCard/refreshIfStale below (explicit, per-card).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Card } from "./card.js";
import type { CardStore } from "./card-store.js";
import { hashEntry } from "./merge-plan.js";

/** Discriminator for what an on-demand refresh did (T7). `absent` means the
 *  source md vanished under the id — refresh makes NO deletion itself; the caller
 *  decides (the T4 sweep hard-deletes during walks). Mirrors the T3 mirror's three
 *  hash-compare arms (inserted/updated/unchanged) + the new ABSENT arm. */
export type RefreshAction = "inserted" | "updated" | "unchanged" | "absent";

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

/** Re-derive the source md path for a planning Card.id under fsRoot. Because
 *  `card_md_hash` keys by card_id only (NO `source_path` column — DDL pinned in
 *  T1), the path is recovered from the id:
 *    planning-effort:<effort>      → <fsRoot>/.planning/<effort>/map.md
 *    planning-ticket:<effort>:<no> → glob <fsRoot>/.planning/<effort>/tickets/<no>-*.md
 *  (the id carries effort+no, NOT the slug — the slug is recovered by glob).
 *  Returns null for an unrecognised id / missing dir / no matching glob. */
function sourcePathForId(cardId: string, fsRoot: string): string | null {
  if (cardId.startsWith("planning-effort:")) {
    const effort = cardId.slice("planning-effort:".length);
    return join(fsRoot, ".planning", effort, "map.md");
  }
  if (cardId.startsWith("planning-ticket:")) {
    const rest = cardId.slice("planning-ticket:".length); // <effort>:<no>
    const sep = rest.lastIndexOf(":");
    if (sep < 0) return null;
    const effort = rest.slice(0, sep);
    const no = rest.slice(sep + 1);
    const dir = join(fsRoot, ".planning", effort, "tickets");
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return null;
    }
    const match = names.find((n) => n.startsWith(`${no}-`) && n.endsWith(".md"));
    return match ? join(dir, match) : null;
  }
  return null;
}

/** On-demand refresh of ONE planning card (T7 — explicit, NOT every-read-rehash).
 *  Re-reads the source md for cardId, re-deserializes, re-hashes, and re-mirrors
 *  via the SAME hash-compare branch as the T3 mirror
 *  (walk-and-ingest.mirrorPlanningToStore):
 *    - no existing card (getCard null) OR no stored hash → INSERT (upsertCard) + write hash;
 *    - stored.hash !== incoming → UPDATE (updateCard) + refresh hash;
 *    - hash match → UNCHANGED (no write).
 *  PLUS a new ABSENT arm: if the source md is gone (path unresolved / read fails /
 *  id unrecognised / no card with that id in the file) returns {action:'absent'}
 *  WITHOUT deleting — the caller decides (T4's reconcilePlanningDeletions hard-
 *  deletes during walks). Call this when freshness is needed for a specific card;
 *  regular getCard/getCardsByKind do NOT re-hash (freshness = T6 backfill + this). */
export async function refreshPlanningCard(
  store: CardStore,
  cardId: string,
  fsRoot: string,
): Promise<{ action: RefreshAction }> {
  const src = sourcePathForId(cardId, fsRoot);
  if (!src) return { action: "absent" };
  let bytes: string;
  try {
    bytes = readFileSync(src, "utf8");
  } catch {
    return { action: "absent" };
  }
  // Derive the kind from the id prefix (the serializer registry is keyed by kind).
  const kind = cardId.startsWith("planning-effort:")
    ? "planning-effort"
    : cardId.startsWith("planning-ticket:")
      ? "planning-ticket"
      : null;
  if (!kind) return { action: "absent" };
  const serializer = store.serializerFor(kind);
  if (!serializer) return { action: "absent" };
  const cards = serializer.deserialize(bytes, { filePath: src });
  const card = cards.find((c) => c.id === cardId);
  if (!card) return { action: "absent" };

  // Same hash-compare branch as the T3 mirror (walk-and-ingest.mirrorPlanningToStore):
  const incomingHash = planningContentHash(card);
  const existing = await store.getCard(cardId);
  const stored = await getStoredHash(store, cardId);
  if (existing === null || stored === null) {
    await store.upsertCard(card);
    await upsertHash(store, cardId, incomingHash);
    return { action: "inserted" };
  }
  if (stored.hash !== incomingHash) {
    await store.updateCard(card);
    await upsertHash(store, cardId, incomingHash);
    return { action: "updated" };
  }
  return { action: "unchanged" };
}

/** True iff a refresh actually re-mirrored (drift detected → inserted|updated).
 *  Thin wrapper over refreshPlanningCard. */
export async function refreshIfStale(
  store: CardStore,
  cardId: string,
  fsRoot: string,
): Promise<boolean> {
  const r = await refreshPlanningCard(store, cardId, fsRoot);
  return r.action === "inserted" || r.action === "updated";
}
