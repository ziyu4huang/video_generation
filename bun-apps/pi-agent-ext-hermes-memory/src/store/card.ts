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
  | "planning-ticket";

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
 *  - `embed?` / `graph?` are part of the TYPE but NOT persisted/indexed in 06a
 *    (embed → ticket 04 / 06b; graph → ticket 03 / 06b). They round-trip as
 *    `undefined` through the 06a SQLite path. */
export interface Card {
  id: string;
  kind: CardKind;
  content: string;
  frontmatter: Record<string, unknown>;
  embed?: unknown;          // 04/06b — left opaquely typed in 06a (not indexed)
  graph?: CardGraph;        // 03/06b — stored on the Card object, not indexed
}

/** Graph fields a card MAY carry. Populated by KnowledgeSerializer from vault-md
 *  (`## 連結` wiki-links + `entities`/`relations` frontmatter). NOT persisted to
 *  SurrealDB graph edges in 06a (placeholder) — flagged for ticket 03 / 06b. */
export interface CardGraph {
  /** Wiki-link neighbours (slug basenames), parsed from `## 連結` lines. */
  links?: string[];
  /** Typed entities, parsed from additive `entities: [type:name,…]` frontmatter. */
  entities?: Array<{ type: string; name: string }>;
  /** Typed relations, parsed from additive `relations: [{s,rel,o}]` frontmatter
   *  (only present when `kg.llm` wrote them — ticket 03 fork 2.1). */
  relations?: Array<{ s: string; rel: string; o: string }>;
}
