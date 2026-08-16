// src/store/card.ts — hermes-internal card-agnostic model.

/** Discriminator for a Card. Generalizes `MemoryTarget`
 *  (`"memory" | "user" | "failure"`) with the new `"knowledge"` kind.
 *  `CardKind ⊋ MemoryTarget`: every MemoryTarget is a CardKind, plus knowledge. */
export type CardKind =
  | "memory"
  | "user"
  | "failure"
  | "knowledge"
  | "planning-effort"
  | "planning-ticket"
  // image cards (ticket 07): knowledge zettel envelope +
  // format/dimensions/locator; content = merged OCR+vision text;
  // atomic one-image-one-card.
  | "image";

/** A card-agnostic record the kind-agnostic store CRUD/queries/dedups over.
 *
 *  `id` IS the stable canonical join key, NOT the DB rowid: it generalizes
 *  `MemoryEntry.mdId` ↔ SQLite `memories.md_id` ↔ Surreal `mdId` (the
 *  frontmatter `id` mirrored onto the row). The numeric DB rowid
 *  (`MemoryEntry.id`) stays DB-internal and never appears on Card.
 *
 *  - `kind` discriminates the serializer + dedup strategy (and, after schema
 *    widening, the `memories.target` value).
 *  - `content` is the canonical body text (memory: the fenced entry body;
 *    knowledge: the `## 核心想法` detail body).
 *  - `frontmatter` is the kind-specific metadata envelope (memory: id/created/
 *    last/state/severity/pin/provenance/...; knowledge: id/created/tags/
 *    record_type/status/superseded_by/confidence/dimension/entities/...).
 *  - `graph?` IS persisted (03): a nullable `graph` JSON column next to
 *    `frontmatter` round-trips it; it is not graph-indexed (the persistent
 *    relation index is a deferred scale-trigger ticket). (Removed in 09: the
 *    never-persisted `embed?` type stub.) */
export interface Card {
  id: string;
  kind: CardKind;
  content: string;
  frontmatter: Record<string, unknown>;
  graph?: CardGraph;        // 03 — persisted (nullable `graph` JSON col); not indexed
}

/** Graph fields a card MAY carry. Populated by KnowledgeSerializer from vault-md
 *  (`## 連結` wiki-links + `entities`/`relations` frontmatter). Persisted as a
 *  nullable `graph` JSON column next to `frontmatter` (03, SQLite round-trip);
 *  NOT mirrored to SurrealDB graph edges (the persistent relation index is a
 *  deferred scale-trigger ticket). */
export interface CardGraph {
  /** Wiki-link neighbours (slug basenames), parsed from `## 連結` lines. */
  links?: string[];
  /** Typed entities, parsed from additive `entities: [type:name,…]` frontmatter. */
  entities?: Array<{ type: string; name: string }>;
  /** Typed relations, parsed from additive `relations: [{s,rel,o}]` frontmatter. */
  relations?: Array<{ s: string; rel: string; o: string }>;
}
