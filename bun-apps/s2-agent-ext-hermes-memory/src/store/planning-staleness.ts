// src/store/planning-staleness.ts — staleness dependency-graph compute layer
// (Phase-2 / ticket 10). Path B (decision η): a card's deps are sourced by
// re-parsing the git-canonical source .md via readSourceCard, NOT from
// store.getCard().graph.relations — the 06a store does NOT persist card.graph
// (card.ts: "round-trips as undefined"; rowToCard emits no graph; the memories
// table has no graph column). The deserialized source card HAS graph.relations
// (blocked-by/cites/depends_on), so depAggregateHash sees real deps.
//
// Two entry points:
//   - computeStaleness: READ-side. Seeds the baseline on first touch; otherwise
//     COMPARE-ONLY (no rebaseline) so a stale card stays flagged until explicitly
//     re-validated (refreshStaleness in planning-sync-state.ts). Used by the
//     graduation gate, the stale: query, and the session_start sweep.
//   - getStaleCards: enumerates stale planning-tickets, optionally scoped to one
//     effort. Drives both the stale: query and the hermes->wayfind reverse seam.
//
// Async because readSourceCard/CardStore.getCardsByKind/getCardDepHash are async
// (the store is async-wrapped for retry + corruption recovery; readSourceCard is
// async to match that envelope), and the dep reads touch the filesystem.
import type { CardStore } from "./card-store.js";
import { depAggregateHash, readSourceCard, writeValidatedBaseline } from "./planning-sync-state.js";

/** Minimal cross-seam stale-decision descriptor. Duplicated (no shared import)
 *  in wayfind's stale-seam.ts — ADR-wayfind-0004. `missingDeps` is present only when one
 *  or more deps are absent on disk (a vanishing dep is itself a staleness signal). */
export interface StaleCard {
  cardId: string;
  effort: string;
  missingDeps?: string[];
}

/** Derive the effort slug from a planning-ticket Card.id
 *  (`planning-ticket:<effort>:<no>` → `<effort>`). null for non-ticket ids.
 *  Used to scope {@link getStaleCards} to one effort + to populate StaleCard.effort. */
function effortOfTicketCardId(cardId: string): string | null {
  if (!cardId.startsWith("planning-ticket:")) return null;
  const rest = cardId.slice("planning-ticket:".length); // <effort>:<no>
  const sep = rest.lastIndexOf(":");
  return sep > 0 ? rest.slice(0, sep) : null;
}

/** On-access staleness verdict for ONE card. Path B (decision η): the card (and
 *  its graph.relations deps) come from {@link readSourceCard} — a re-parse of the
 *  git-canonical source .md — NOT from store.getCard (whose row drops `graph`).
 *  An unresolvable source (no md / id not in the file) → {stale:false, missing:[]}
 *  and writes NO baseline (cannot validate what we cannot read). Seeds the
 *  baseline on first touch (so there is something to compare against) then
 *  COMPARES ONLY — a stale card is NOT re-baselined here (re-baselining is the
 *  explicit refreshStaleness op in T5). */
export async function computeStaleness(
  store: CardStore,
  cardId: string,
  fsRoot: string,
): Promise<{ stale: boolean; missing: string[] }> {
  const card = await readSourceCard(store, cardId, fsRoot);
  if (!card) return { stale: false, missing: [] };
  const { hash: current, missing } = await depAggregateHash(card, fsRoot);
  const stored = await store.getCardDepHash(cardId);
  if (!stored) {
    // First check: seed the baseline. The card cannot be "stale since last
    // validation" before it has ever been validated. Reuses the same
    // depAggregateHash + upsertCardDepHash path as the explicit re-validate op.
    await writeValidatedBaseline(store, card, fsRoot);
    return { stale: false, missing };
  }
  return { stale: current !== stored.depHash || missing.length > 0, missing };
}

/** All stale planning-ticket cards, optionally scoped to `effort`. Enumerates
 *  via store.getCardsByKind("planning-ticket") (card ids only — the store row
 *  needs NO graph; deps come from readSourceCard inside computeStaleness). Each
 *  result carries the card id, its effort, and (when any deps are absent) the
 *  missing dep paths. Drives the stale: query + the hermes->wayfind reverse seam. */
export async function getStaleCards(
  store: CardStore,
  effort: string | undefined,
  fsRoot: string,
): Promise<StaleCard[]> {
  const tickets = await store.getCardsByKind("planning-ticket");
  const out: StaleCard[] = [];
  for (const card of tickets) {
    const cardEffort = effortOfTicketCardId(card.id);
    if (!cardEffort) continue;
    if (effort && cardEffort !== effort) continue;
    const { stale, missing } = await computeStaleness(store, card.id, fsRoot);
    if (stale) {
      out.push({
        cardId: card.id,
        effort: cardEffort,
        ...(missing.length > 0 ? { missingDeps: missing } : {}),
      });
    }
  }
  return out;
}
