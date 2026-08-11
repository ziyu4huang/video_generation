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
 *  Returns null for an unrecognised id / missing dir / no matching glob.
 *  Exported (10-impl T4 / decision η) so {@link readSourceCard} (and T4's
 *  staleness compute) can re-derive a card from its source .md. */
export function sourcePathForId(cardId: string, fsRoot: string): string | null {
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

/** Re-parse the git-canonical source .md for a planning card id → the Card
 *  (10-impl T4 / decision η — Path B). The 06a store does NOT persist card.graph
 *  (it round-trips as `undefined`; `rowToCard` emits no `graph`), so callers that
 *  need a card's `graph.relations` (deps for staleness) MUST re-derive the card
 *  from its source .md rather than read the store row. Mirrors the resolve→read→
 *  deserialize→find body that {@link refreshPlanningCard} inlined pre-T4; factored
 *  out here so refreshPlanningCard + computeStaleness share one source-of-truth
 *  reader. Returns null when the source is unresolvable / unreadable / the id is
 *  not present in the file (no deletion — callers decide). Async to match the
 *  CardStore async envelope + future async-fs evolution. */
export async function readSourceCard(
  store: CardStore,
  cardId: string,
  fsRoot: string,
): Promise<Card | null> {
  const src = sourcePathForId(cardId, fsRoot);
  if (!src) return null;
  let bytes: string;
  try {
    bytes = readFileSync(src, "utf8");
  } catch {
    return null;
  }
  // Derive the kind from the id prefix (the serializer registry is keyed by kind).
  const kind = cardId.startsWith("planning-effort:")
    ? "planning-effort"
    : cardId.startsWith("planning-ticket:")
      ? "planning-ticket"
      : null;
  if (!kind) return null;
  const serializer = store.serializerFor(kind);
  if (!serializer) return null;
  const cards = serializer.deserialize(bytes, { filePath: src });
  return cards.find((c) => c.id === cardId) ?? null;
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
  const card = await readSourceCard(store, cardId, fsRoot);
  if (!card) return { action: "absent" };

  // Same hash-compare branch as the T3 mirror (walk-and-ingest.mirrorPlanningToStore),
  // split so an existing-but-unhashed card (08→09 migration cohort) routes to
  // UPDATE, not an insert-no-op that freezes the row at 08-era content
  // (09-impl final review B):
  //   - no existing card (getCard null) → INSERT (upsertCard) + write hash;
  //   - existing card BUT no stored hash, OR stored.hash !== incoming → UPDATE;
  //   - hash match → UNCHANGED (no write).
  const incomingHash = planningContentHash(card);
  const existing = await store.getCard(cardId);
  const stored = await getStoredHash(store, cardId);
  if (existing === null) {
    await store.upsertCard(card);
    await upsertHash(store, cardId, incomingHash);
    return { action: "inserted" };
  }
  if (stored === null || stored.hash !== incomingHash) {
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

// ─── 10-impl staleness: dep aggregate hash + validated baseline ─────────────
//
// The staleness baseline is ONE aggregate row per card in card_dep_hash =
// hashEntry(sorted(cited+depends_on source-file bytes)). Distinct from 09's
// card_md_hash (which hashes the CARD's own bytes); this hashes the bytes of
// the files the card's decision DEPENDS ON, so a change to a cited/declared
// source file flips the card stale even when the card's own md is unchanged.

/** Distinct repo-relative dep paths carried by a card's graph.relations
 *  (rel ∈ {"cites","depends_on"}). First-occurrence dedupe → stable order. */
export function citedDeps(card: Card): string[] {
  const rels = card.graph?.relations ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rels) {
    if ((r.rel === "cites" || r.rel === "depends_on") && !seen.has(r.o)) {
      seen.add(r.o);
      out.push(r.o);
    }
  }
  return out;
}

/** Aggregate content-hash of a card's deps under fsRoot. For each dep path,
 *  read join(fsRoot, path): present → hashEntry(bytes); absent → recorded in
 *  `missing` AND contributes the token "<missing>" (so a file reappearing or
 *  vanishing changes the aggregate). Aggregate = hashEntry of the sorted
 *  `${path}:${hashOrToken}` entries joined by "\n" — deterministic over the
 *  dep SET regardless of relation order. A card with NO deps hashes the empty
 *  string (stable → never stale by dep-change, which is correct: nothing to
 *  depend on). */
export async function depAggregateHash(
  card: Card,
  fsRoot: string,
): Promise<{ hash: string; missing: string[] }> {
  const deps = citedDeps(card);
  const missing: string[] = [];
  const entries = deps.map((path) => {
    let fileHash: string;
    try {
      fileHash = hashEntry(readFileSync(join(fsRoot, path), "utf8"));
    } catch {
      missing.push(path);
      fileHash = "<missing>";
    }
    return `${path}:${fileHash}`;
  });
  entries.sort();
  return { hash: hashEntry(entries.join("\n")), missing };
}

/** Compute the dep aggregate + UPSERT it as the card's validated baseline
 *  (the staleness reference). This is the RE-VALIDATE write — call it when an
 *  agent re-grills + re-validates a decision (clears stale). The on-access
 *  computeStaleness (T4) uses depAggregateHash WITHOUT writing except the
 *  first-touch seed. */
export async function writeValidatedBaseline(
  store: CardStore,
  card: Card,
  fsRoot: string,
): Promise<{ hash: string; missing: string[] }> {
  const { hash, missing } = await depAggregateHash(card, fsRoot);
  await store.upsertCardDepHash(card.id, hash);
  return { hash, missing };
}

/** Explicit RE-VALIDATE of ONE card (the agent re-grill flow — T6's `planning_stale`
 *  tool `revalidate` action): recompute the dep aggregate, report whether it HAD
 *  drifted relative to the OLD baseline, AND re-baseline to the CURRENT bytes
 *  (clearing the stale flag). This is the SOLE re-baseline op — distinct from
 *  {@link computeStaleness} (planning-staleness.ts), which is compare-only after
 *  the first-touch seed and NEVER clears a stale flag.
 *
 *  Path B (decision η): deps come from {@link readSourceCard} (a re-parse of the
 *  git-canonical source .md → graph.relations), NOT `store.getCard` (whose row
 *  drops `graph`, so `depAggregateHash` would hash the empty aggregate and never
 *  detect drift). An unresolvable source → `false` + NO write (cannot validate
 *  what we cannot read). Mirrors {@link refreshIfStale}'s boolean envelope.
 *
 *  The `session_start` sweep (planning-backfill.ts) does NOT call this — it flags
 *  via `computeStaleness` so stale state PERSISTS across sessions (decision ζ); a
 *  re-baselining sweep would wipe stale state every session start. Returns `true`
 *  iff re-validation cleared a stale state: the card HAD a stored baseline whose
 *  dep hash differs from the current aggregate, OR a dep is currently missing
 *  (a vanishing dep is itself a stale signal that survives re-baselining). */
export async function refreshStaleness(
  store: CardStore,
  cardId: string,
  fsRoot: string,
): Promise<boolean> {
  const card = await readSourceCard(store, cardId, fsRoot);
  if (!card) return false;
  const { hash: current, missing } = await depAggregateHash(card, fsRoot);
  const stored = await store.getCardDepHash(cardId);
  const wasStale = stored !== null && (current !== stored.depHash || missing.length > 0);
  // Re-baseline NOW to the CURRENT bytes: the NEXT change after this point is
  // what re-flags stale. writeValidatedBaseline recomputes the aggregate once
  // more (deterministic, idempotent — matches computeStaleness's first-touch path).
  await writeValidatedBaseline(store, card, fsRoot);
  return wasStale;
}
