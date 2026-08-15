/**
 * memory-card-mirror.ts — kp13 Wave B writer-mirror helpers.
 *
 * md stays CANONICAL: MemoryStore keeps writing MEMORY.md / USER.md /
 * failures.md byte-for-byte unchanged. These helpers re-point ONLY the DB
 * mirror target of the memory-kind writers (memory tool, supersede,
 * grill_decision, correction/error detectors, review-memory-ops,
 * sync-markdown startup pass) from the legacy
 * `MemoryRepository.syncMemoryEntry` / `replaceSyncedMemories` /
 * `removeSyncedMemories` content-keyed mirror to the bundle's CardStore
 * (md_id-keyed rows in the SAME `memories` table — `target` = kind,
 * `md_id` = the §-entry frontmatter id, `content` = the entry body,
 * `frontmatter` = the serializer envelope).
 *
 * `syncMemoryEntry` & co STAY on the MemoryRepository interface — sessions
 * and non-memory uses still call them; Wave B only removes them from the
 * memory-kind hot path (enforced by the memory-mirror sole-source gate test).
 *
 * Envelope discipline: the mirror Card is NEVER hand-rolled here. It is built
 * by round-tripping the entry through the shared §-md codec
 * (`serializeMetadataFrontmatter` → `serializerFor(kind).deserialize`) — the
 * exact bytes path MemorySerializer itself owns — so the envelope is whatever
 * the registered serializer derives from canonical entry bytes.
 *
 * Dedup: `upsertCard` dispatches through the registered `MemoryDedupStrategy`,
 * which for memory kinds is IDENTITY-keyed (same md_id → skip; distinct md_id →
 * keep — the md layer already refuses exact dups and warns-only on near-dups
 * BEFORE the mirror runs, so content overlap must not drop a row here).
 */

import type { Card, CardKind } from "./card.js";
import type { CardStore } from "./card-store.js";
import type { FailureState } from "../types.js";
import { serializeMetadataFrontmatter, today } from "./memory-format.js";
import { normalizeMemoryLookupText } from "./memory-lookup.js";

/** The memory-family kinds these helpers mirror (matches MemorySerializer's
 *  constructor kinds and the CardStore memory-dedup registrations). */
export type MemoryCardKind = Extract<CardKind, "memory" | "user" | "failure">;

/** What one writer knows at mirror time. `mdId` is the §-entry frontmatter
 *  id (MemoryResult.added_md_id on the live path, ParsedMarkdownMemoryEntry
 *  .mdId on the startup path) — the canonical join key. */
export interface MemoryCardInput {
  mdId: string | null | undefined;
  content: string;
  created?: string | null;
  last?: string | null;
  state?: FailureState | null;
  severity?: number | null;
  pin?: boolean | null;
}

/** Build the mirror Card through the serializer registry: serialize the entry
 *  to canonical §-md bytes, then deserialize via `cardStore.serializerFor
 *  (kind)` — the envelope is the serializer's decode, never a hand-rolled
 *  object. Returns null when the entry carries no stable id (comment-shape
 *  legacy entries: not yet upgraded by the 5d backfill) or the kind has no
 *  registered serializer (cannot happen for memory/user/failure). */
export function buildMemoryCard(
  cardStore: CardStore,
  kind: MemoryCardKind,
  input: MemoryCardInput,
): Card | null {
  if (!input.mdId) return null;
  const serializer = cardStore.serializerFor(kind);
  if (!serializer) return null;
  const created = input.created ?? today();
  const bytes = serializeMetadataFrontmatter({
    id: input.mdId,
    text: input.content,
    created,
    last: input.last ?? created,
    state: input.state ?? null,
    severity: input.severity ?? null,
    pin: input.pin === true ? true : null,
    provenance: null,
    sources: null,
    mwSuccess: null,
    mwFail: null,
  });
  const cards = serializer.deserialize(bytes);
  return cards.length > 0 ? cards[0] : null;
}

/** Delete the card rows of `kind` whose content matches `oldText` (the legacy
 *  content-LIKE scope of replaceSyncedMemories/removeSyncedMemories, keyed on
 *  the normalized lookup text). Returns the number of matched rows. */
async function deleteCardsByContent(
  cardStore: CardStore,
  kind: MemoryCardKind,
  oldText: string,
): Promise<number> {
  const needle = normalizeMemoryLookupText(oldText);
  if (!needle) return 0;
  const cards = await cardStore.getCardsByKind(kind);
  const hits = cards.filter((c) => c.content.includes(needle));
  for (const card of hits) {
    // deleteCard IS the delete-by-md-id seam (Card.id == memories.md_id ==
    // surreal mdId) — surfaced on the public CardStore since 06a.
    await cardStore.deleteCard(card.id);
  }
  return hits.length;
}

/** Add-mirror: upsert one md_id-keyed Card through the registered
 *  MemoryDedupStrategy (no call-site dedup). Returns true when a Card was
 *  actually mirrored; false when the entry carries no stable id or the kind
 *  has no serializer (both are no-ops, not errors — md stays canonical). */
export async function mirrorMemoryAdd(
  cardStore: CardStore | null,
  kind: MemoryCardKind,
  input: MemoryCardInput,
): Promise<boolean> {
  if (!cardStore) return false;
  const card = buildMemoryCard(cardStore, kind, input);
  if (!card) return false;
  await cardStore.upsertCard(card);
  return true;
}

/** Replace-mirror. An `.md` replace mints a FRESH frontmatter id
 *  (MemoryStore._replaceInner), so the md_id-keyed end state is: no row for
 *  the old entry + exactly one row carrying the new id/content. Mirror =
 *  delete the content-matching old row(s), then upsert the new Card. Returns
 *  the number of OLD rows matched (legacy matched-count parity: 0 → the
 *  caller's "no matching search store row was updated" warning). */
export async function mirrorMemoryReplace(
  cardStore: CardStore | null,
  kind: MemoryCardKind,
  oldText: string,
  input: MemoryCardInput,
): Promise<number> {
  if (!cardStore) return 0;
  const matched = await deleteCardsByContent(cardStore, kind, oldText);
  const card = buildMemoryCard(cardStore, kind, input);
  if (card) await cardStore.upsertCard(card);
  return matched;
}

/** Remove-mirror: delete the content-matching card row(s). Returns the number
 *  of matched rows (legacy removeSyncedMemories matched-count parity). */
export async function mirrorMemoryRemove(
  cardStore: CardStore | null,
  kind: MemoryCardKind,
  oldText: string,
): Promise<number> {
  if (!cardStore) return 0;
  return deleteCardsByContent(cardStore, kind, oldText);
}

/** Outcome of one md_id-keyed lazy re-migration step. */
export type MirrorEntryOutcome = "inserted" | "updated" | "skipped" | "no-stable-id";

/** Idempotent md_id-keyed upsert (the lazy re-migration primitive, used by
 *  the sync-markdown startup pass):
 *  - no card for the id → `upsertCard` (INSERT through the registered dedup);
 *  - card exists but content OR envelope drifted → `updateCard` (UPDATE in
 *    place — the id stays stable; this is also how the failure-state backfill
 *    stamps a `state` onto an already-mirrored card);
 *  - card exists and is identical → no-op (`skipped`).
 *  Entries without a stable id (comment-shape, pre-5d) return `no-stable-id`:
 *  they mirror on a later pass once the 5d backfill upgrades them — that is
 *  what makes the startup pass LAZY. */
export async function mirrorMemoryEntry(
  cardStore: CardStore | null,
  kind: MemoryCardKind,
  input: MemoryCardInput,
): Promise<MirrorEntryOutcome> {
  if (!cardStore) return "skipped";
  const card = buildMemoryCard(cardStore, kind, input);
  if (!card) return "no-stable-id";
  const existing = await cardStore.getCard(card.id);
  if (!existing) {
    await cardStore.upsertCard(card);
    return "inserted";
  }
  if (
    existing.content !== card.content ||
    JSON.stringify(existing.frontmatter) !== JSON.stringify(card.frontmatter)
  ) {
    await cardStore.updateCard(card);
    return "updated";
  }
  return "skipped";
}
