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
 * Wave C finishes the retirement: eviction/offload/transfer cleanup moves off
 * `memoryRepo.removeByMdId` onto `mirrorMemoryEvictions` (deleteCard by
 * md_id), so the memory-kind writers hold NO memoryRepo seam at all.
 *
 * Envelope discipline: the mirror Card is NEVER hand-rolled here. It is built
 * by round-tripping the entry through the shared §-md codec
 * (`serializeMetadataFrontmatter` → `serializerFor(kind).deserialize`) — the
 * exact bytes path MemorySerializer itself owns — so the envelope is whatever
 * the registered serializer derives from canonical entry bytes.
 *
 * Dedup: `upsertCard` dispatches through the registered `MemoryDedupStrategy`,
 * which for memory kinds is IDENTITY-keyed (same md_id → skip; distinct md_id →
 * keep — the md layer already refuses exact dups BEFORE the mirror runs, so
 * content overlap must not drop a row here).
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

/** Eviction-mirror (kp13 Wave C — retires the last legacy memoryRepo call on
 *  the memory-kind hot path, `removeByMdId`): hard-delete the mirrored card
 *  rows for retired md_ids via `deleteCard` — the public delete-by-md-id seam
 *  (Card.id == memories.md_id == surreal mdId). md_ids are globally unique
 *  (5d), so id-keyed delete needs no target/project scope. md stays canonical:
 *  MemoryStore already removed the entries from MEMORY.md/USER.md/failures.md;
 *  this deletes the mirrored rows so evicted/offloaded-superseded/transferred
 *  entries die tracelessly in the store too. Per-id best-effort (a throw is
 *  swallowed — eviction cleanup must not fail the write, exactly like the
 *  legacy loop). Returns the number of delete calls that did not throw
 *  (deleteCard is void; ids come from the store's own retire result, so a
 *  no-row id is a benign zero-change DELETE). Null cardStore → 0. */
export async function mirrorMemoryEvictions(
  cardStore: CardStore | null,
  mdIds: string[] | undefined,
): Promise<number> {
  if (!cardStore || !mdIds || mdIds.length === 0) return 0;
  let deleted = 0;
  for (const mdId of mdIds) {
    try {
      await cardStore.deleteCard(mdId);
      deleted++;
    } catch {
      // best-effort — never fail the md write that already succeeded
    }
  }
  return deleted;
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

/** Batched mirrorMemoryEntry for the startup sync pass (2026-08-24 perf fix:
 * the per-entry `getCard` made the pass an N+1 — 103 HTTP round-trips /
 * ~1.2–1.6s measured on the real surreal backend, every session). ONE
 * `getCardsByKind` replaces the per-entry lookup: md_ids are globally unique
 * (5d), so a kind-scoped id→card map is equivalent to the per-id getCard.
 * (2026-08-25 follow-up, the dirty-vault path: `existingById` lets the sync
 * pass share ONE kind index across every file of the run — a 26-file sync was
 * 26 read round-trips — and drifted updates collapse into ONE
 * `updateCardsBatch` transaction instead of one round-trip per entry.)
 * Inserts stay per-entry through the upsertCard dedup seam (steady state =
 * zero inserts, zero write round-trips). The passed `existingById` map is
 * TRUSTED as the kind's index and kept write-through current (insert/update
 * set the mirrored card) so later files in the same run see this run's
 * writes. Outcome order matches the input order; an empty/null cardStore
 * mirrors to all-"skipped". */
export async function mirrorMemoryEntries(
  cardStore: CardStore | null,
  kind: MemoryCardKind,
  inputs: MemoryCardInput[],
  existingById?: Map<string, Card>,
): Promise<MirrorEntryOutcome[]> {
  if (!cardStore) return inputs.map(() => "skipped" as const);
  const cards = inputs.map((input) => buildMemoryCard(cardStore, kind, input));
  const byId = existingById ?? new Map((await cardStore.getCardsByKind(kind)).map((c) => [c.id, c]));
  const outcomes: MirrorEntryOutcome[] = [];
  const drifted: Card[] = [];
  for (const card of cards) {
    if (!card) {
      outcomes.push("no-stable-id");
      continue;
    }
    const existing = byId.get(card.id);
    if (!existing) {
      await cardStore.upsertCard(card);
      byId.set(card.id, card);
      outcomes.push("inserted");
    } else if (
      existing.content !== card.content ||
      JSON.stringify(existing.frontmatter) !== JSON.stringify(card.frontmatter)
    ) {
      drifted.push(card);
      byId.set(card.id, card);
      outcomes.push("updated");
    } else {
      outcomes.push("skipped");
    }
  }
  if (drifted.length > 0) {
    try {
      await cardStore.updateCardsBatch(drifted);
    } catch {
      // Atomic batch applied nothing — redo per-entry so a single bad card
      // surfaces through the caller's existing per-entry fallback.
      for (const card of drifted) await cardStore.updateCard(card);
    }
  }
  return outcomes;
}
