---
status: draft
effort: 2026-08-08-knowledge-pipeline
ticket: "06a"
date: 2026-08-09
---
# Hermes card-agnostic store — design (knowledge-pipeline task 06a)

> **Split note:** Ticket 06 ("hermes-as-spine orchestration") implementation is
> split into **06a — card-agnostic store** (this spec + its plan) and **06b —
> spine orchestrator** (`ingestPath`/`walkAndIngest`, zk→store mirror wiring,
> embed index, drift hooks — TBD, separate grilling). 06a makes the hermes
> store kind-agnostic and knowledge-capable; it does NOT build the orchestrator.

## Context
Task 06a of the knowledge-pipeline effort — the first half of ticket 06. The
store contract is pinned across three load-bearing tickets:

- **Ticket 01** (closed) — the unified card model + the kind-agnostic store via
  a pluggable serializer + dedup as a single store call-site behind a pluggable
  strategy. (01's orchestration framing was superseded by 06; its three core
  decisions STAND.)
- **Ticket 05** (closed) — memory-cards COEXIST on hermes's current proven
  section-md path during the build (migrate-at-graduation = the FINAL milestone,
  ticket 13); DB↔md drift resolves by field-classification (Tier 1 md-canonical
  re-index, Tier 2 derived-cache regenerate, Tier 3 DB-authoritative opt-in,
  merge-plan only for genuine md↔db content conflicts).
- **Ticket 06** (closed) — hermes is the spine: it owns the pipeline
  orchestration entry + the store; zk is a primitives provider. **06a covers
  only the store half.** 06 confirms the store generalization target:
  "hermes owns store (`MemoryRepository`/backend-ab, memory-shaped → generalize
  per 01)".

This spec is the design for that store generalization. It is grounded in the
real hermes store code (`MemoryStore`, `MemoryRepository`, `BackendBundle`,
`memory-format.ts`, `backend-factory.ts`, `merge-plan.ts`, `near-dup.ts`,
`topic-key.ts`) and the real zk obsidian-md card format
(`knowledge-card/src/ingest.ts` `renderCard` + `KnowledgeRecord`).

## Goal
Generalize the hermes store from memory-shape-specific (`MemoryEntry`, target ∈
{memory,user,failure}) to a **card-agnostic store** over
`Card { id, kind, content, frontmatter, embed?, graph? }`, with:

1. A pluggable **serializer** interface owning disk (de)serialization per kind —
   two impls: `MemorySerializer` (EXTRACT the existing §-md logic unchanged) and
   `KnowledgeSerializer` (read vault-md knowledge-cards).
2. A pluggable **dedup-strategy** interface behind a single store call-site —
   two impls: `MemoryDedupStrategy` (the existing near-dup/hash logic) and
   `KnowledgeDedupStrategy` (idempotent upsert by `Card.id` for 06a).
3. A backend mapping so a `Card` round-trips through SQLite (the default
   backend); SurrealDB graph persistence for knowledge is a placeholder in 06a.

Memory-cards stay on their current path byte-for-byte (regression-green);
knowledge-cards are a new kind. No migration (that is ticket 13, gated on this).

## Key findings (from code exploration)
- **The join key already exists.** `MemoryEntry.mdId` ↔ SQLite column
  `memories.md_id` (UNIQUE index `idx_memories_md_id`) ↔ Surreal field `mdId`.
  It is the stable markdown-side id mirrored from the `.md` frontmatter `id`.
  `Card.id` IS this key (generalized), NOT the numeric DB rowid
  (`MemoryEntry.id`). → `Card.id ↔ MemoryEntry.mdId ↔ memories.md_id`.
- **The §-md codec is already isolated and pure.** `memory-format.ts` owns
  `serializeMetadataFrontmatter` / `parseMetadataFrontmatter` /
  `parseMetadataComment` / `detectEntryShape` / `upgradeEntryToFrontmatter` —
  zero DB coupling. `MemoryStore.encodeEntry`/`decodeEntry`/`mdIdOf` are thin
  delegates. Extracting a `MemorySerializer` is a relocation, not a rewrite.
- **The dedup primitives already exist.** `near-dup.ts` (`findNearDuplicate`,
  `nearDupTokens`, `containment`), `topic-key.ts` (`findTopicRecurrence`,
  `topicKey`), `merge-plan.ts` (`hashEntry`, `snapshotBaseHash`, optimistic
  concurrency via `baseHashMatched`), and `MemoryStore.dedupEntries`/
  `dedupNormalize` (exact-stripped-equality). `MemoryDedupStrategy` composes
  these; it is not new logic.
- **The SQLite schema constrains `target`.** `memories.target` has a CHECK
  constraint `IN ('memory', 'user', 'failure')`. Persisting knowledge-cards in
  the same table requires widening it (06a decision, below). `memory_fts`
  (FTS5) indexes `content` via triggers — knowledge-cards get FTS for free once
  they land in `memories`.
- **The two disk formats differ in cardinality.** Memory = **many fenced
  entries per `.md` file** (section-md, joined by `ENTRY_DELIMITER`, in
  `.agents/memory/*.md`). Knowledge = **one card per vault `.md` file**
  (obsidian convention, in vault folder `Zettelkasten/knowledge-graph`). The
  serializer interface must abstract over both — hence `deserialize(file) → Card[]`
  (N for memory, 0/1 for knowledge) and `serialize(card) → string` (one fragment
  / one file body), with the store owning file-level assembly.
- **The zk card frontmatter is rich.** `id, created, tags:[zettel,…], sources,
  source, source_id, record_type, status, superseded_by, confidence,
  [dimension, entities:[type:name,…], feature flags]`; body is
  `# title / ## 核心想法 <detail> / ## 證據 / 脈絡 <evidence> / ## 連結 <links>`;
  validated by `validateZettelNote` (requires id/created/tags, `tags[0]=="zettel"`).
  `KnowledgeSerializer.deserialize` parses this into a `Card`; the `## 連結`
  links + `entities`/`relations` frontmatter become `Card.graph?`.

## Decisions from 01 / 05 / 06 (quoted verbatim, load-bearing)

> **01 — Card model:** one unified `Card { id, kind: "memory"|"knowledge",
> content, frontmatter, embed?, graph? }`. The hermes store is kind-agnostic
> (CRUD / query / dedup / embed over Card). A pluggable serializer per kind owns
> disk serialization + location.
>
> **01 — Seam (what moves DOWN to hermes):** DOWN to hermes store: persistence,
> DB mirror (backend-ab SQLite + SurrealDB), **dedup/conflict call-site +
> default strategy**, embed index, query.
>
> **01 — Dedup / conflict:** ONE call-site in the store behind a **pluggable
> strategy interface**. Default strategy = the existing exact / near-dup /
> topic / merge-plan (card-agnostic, from the prior effort).
>
> **01 — id ↔ DB join key:** unchanged: `Card.id` ↔ DB column `md_id`.
>
> **05 — Coexistence:** memory-cards COEXIST on hermes's current proven
> section-md path while the card-agnostic store is built and stabilized on
> *knowledge*-cards first; the memory-cards move into the unified store as the
> FINAL milestone (ticket 13, blocked by 06).
>
> **06 — Store generalization target:** hermes owns store
> (`MemoryRepository`/backend-ab, memory-shaped → generalize per 01).
> (06a implements the store half only.)

## Design

### 1. Where the types live — hermes-local `src/store/card.ts` (DECISION)
The `Card` model + `CardKind` + `CardSerializer` + `DedupStrategy` interfaces
live in a **new hermes-local module** `bun-apps/pi-agent-ext-hermes-memory/src/store/card.ts`,
NOT in `@repo/pi-agent-ext-core-interface`.

**Rationale:** core-interface is for **cross-extension seams** (the
`KnowledgePipeline` seam zk publishes / hermes reads — ticket 11/12). The Card
model is the store's **internal abstraction**: it is consumed only inside the
hermes store package (the store, its serializers, its dedup strategies, its
SQLite/Surreal repos). Nothing in zk or any other package needs to import `Card`
at compile time in 06a — zk publishes opaque `KnowledgeRecord`s over the seam,
and the `KnowledgeSerializer` (hermes-internal) is what turns vault-md files into
`Card`s. Putting it in core-interface would widen the cross-package surface
prematurely and couple the store's internal schema to the typed seam contract.
**Revisitable in 06b** if the orchestrator needs to surface `Card` across the
seam (e.g. a `queryCards` seam method) — at that point it can graduate to
core-interface.

### 2. The Card model + CardKind (verbatim TS)
```ts
// src/store/card.ts — hermes-internal card-agnostic model.

/** Discriminator for a Card. Generalizes `MemoryTarget`
 *  (`"memory" | "user" | "failure"`) with the new `"knowledge"` kind.
 *  `CardKind ⊋ MemoryTarget`: every MemoryTarget is a CardKind, plus knowledge. */
export type CardKind = "memory" | "user" | "failure" | "knowledge";

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
```

### 3. The serializer interface (verbatim TS)
```ts
/** Owns disk (de)serialization for one CardKind. One impl per kind.
 *
 *  The store is kind-agnostic; the serializer is the kind-specific seam that
 *  abstracts over the two file backings (memory = many fenced entries per .md;
 *  knowledge = one card per vault .md). The store owns file-level assembly
 *  (which fragments concatenate into which file); the serializer owns ONE
 *  card's fragment/file. This mirrors how `memory-format.ts` already works:
 *  `serializeMetadataFrontmatter(entry)` returns one entry's fragment, the
 *  store joins them with `ENTRY_DELIMITER`. */
export interface CardSerializer<K extends CardKind = CardKind> {
  /** The kind this serializer owns. Selects the strategy at the store's
   *  per-kind registry. */
  readonly kind: K;

  /** Serialize ONE card → its on-disk representation.
   *  - memory: a single fenced frontmatter entry (`---\n<yaml>\n---\n<body>`)
   *    — the store concatenates these per file with ENTRY_DELIMITER.
   *  - knowledge: a full obsidian-md file body (`---\n<yaml>\n---\n# title…`).
   *
   *  For `kind:"knowledge"` the store does NOT call this in 06a (vault writes
   *  stay zk-owned per ticket 06 fork 1); it exists for symmetry + future
   *  round-trip and returns a byte-preserving rendering of `card`. */
  serialize(card: Card): string;

  /** Deserialize file bytes → zero or more cards.
   *  - memory: N cards (one per fenced entry in the section-md file).
   *  - knowledge: 0 or 1 card (a vault .md file; 0 when it is not a valid
   *    zettel note — e.g. fails `validateZettelNote`). */
  deserialize(fileBytes: string, opts?: { filePath?: string }): Card[];
}
```

### 4. The dedup-strategy interface (verbatim TS)
```ts
/** The single store dedup call-site: given an incoming card and the existing
 *  set of the SAME kind, decide keep / merge / skip. ONE call-site in the store
 *  (no duplication), kind-specific richness preserved by the impl (ticket 01). */
export interface DedupStrategy<K extends CardKind = CardKind> {
  readonly kind: K;
  dedup(incoming: Card, existing: Card[]): DedupDecision;
}

/** The outcome of a dedup check. */
export interface DedupDecision {
  /** `keep` — insert `incoming` as a new card.
   *  `merge` — `incoming` is a near-duplicate; the store merges it into
   *    `existingId` (compose `merge-plan.ts` for memory; upsert evidence for
   *    knowledge — but knowledge `merge` is a 06b concern; 06a returns skip).
   *  `skip` — `incoming` is a duplicate; drop it (the canonical card is
   *    `existingId`). */
  action: "keep" | "merge" | "skip";
  /** Present for `merge`/`skip`: the existing card's `Card.id`. */
  existingId?: string;
  /** Human-readable rationale (surfaced to the agent as the write-time signal,
   *  mirroring the existing `formatTopicRecurrenceWarning` pattern). */
  reason?: string;
}
```

### 5. Serializer impls
- **`MemorySerializer` (kind: memory|user|failure):** EXTRACT the existing §-md
  logic from `memory-format.ts` unchanged. `serialize(card)` =
  `serializeMetadataFrontmatter({ id: card.id, text: card.content,
  created, last, state, severity, pin, provenance, sources, mwSuccess, mwFail })`
  (read from `card.frontmatter`). `deserialize(fileBytes)` = split on
  `ENTRY_DELIMITER`, and for each entry call `parseMarkdownMemoryEntry`/
  `parseMetadataFrontmatter` (shape-aware via `detectEntryShape`) → a `Card` with
  `kind` = the memory target, `id` = frontmatter `id`, `content` = body,
  `frontmatter` = the decoded envelope. **Memory-cards must not regress** — the
  extracted functions are byte-identical; this task is relocation + a thin Card
  adapter, not a rewrite.
- **`KnowledgeSerializer` (kind: knowledge):** READ vault-md knowledge-cards.
  `deserialize(fileBytes, {filePath})` parses the obsidian frontmatter (YAML) +
  body sections (`## 核心想法` → `content`; `## 連結` → `graph.links`;
  `entities`/`relations` frontmatter → `graph.entities`/`graph.relations`) → a
  `Card` with `kind:"knowledge"`, `id` = frontmatter `id`, `frontmatter` = the
  whole decoded envelope. Returns `[]` when the file is not a valid zettel note
  (reuses `validateZettelNote` shape from the obsidian ext, defensively —
  `KnowledgeSerializer` must not hard-fail the whole store on one malformed
  vault file). `serialize(card)` is provided (byte-preserving rendering) but the
  store does NOT invoke it for knowledge in 06a.

### 6. Dedup-strategy impls
- **`MemoryDedupStrategy` (kind: memory|user|failure):** composes the existing
  primitives — exact stripped-equality (`MemoryStore.dedupNormalize`), near-dup
  containment (`near-dup.ts findNearDuplicate`, threshold
  `DEFAULT_NEAR_DUP_THRESHOLD = 0.6`), topic recurrence (`topic-key.ts
  findTopicRecurrence`), and hash/optimistic-concurrency
  (`merge-plan.ts hashEntry`/`snapshotBaseHash`/`baseHashMatched`). The 06a
  impl wires these behind `DedupStrategy.dedup` so the store's single call-site
  delegates here for memory kinds. Logic is reused, not reinvented.
- **`KnowledgeDedupStrategy` (kind: knowledge) — DECISION, revisitable in 06b:**
  **idempotent upsert by `Card.id`**. `dedup(incoming, existing)`:
  - if an existing card has `id === incoming.id` → `{ action: "skip",
    existingId: incoming.id, reason: "idempotent re-ingest (same canonical id)" }`.
  - else → `{ action: "keep" }`.
  **Rationale:** zk ALREADY does md-layer merge (wiki-aware convergence at
  `wikiThreshold` ≈ 0.85 token-set Jaccard, ticket 06 fork 1). Store-side
  semantic dedup for knowledge (cross-card merge when two different canonical
  ids describe the same lesson) is a real concern but a **06b** concern — 06a
  only proves the store can HOLD knowledge-cards and round-trip them. Returning
  `skip` on id-match makes re-ingest idempotent (re-reading the same vault corpus
  never duplicates rows), which is exactly what the acceptance test needs.
  **Revisit in 06b** once the orchestrator drives live ingest: a richer
  `KnowledgeDedupStrategy` (wiki-aware merge à la zk) can replace this without
  touching the call-site (that is the whole point of the strategy seam).

### 7. Store generalization + backend mapping (DECISION, SQLite scope in 06a)
The store gains a per-kind registry:
`serializers: Map<CardKind, CardSerializer>` and
`dedupStrategies: Map<CardKind, DedupStrategy>`, registered at construction
(Memory + Knowledge). A kind-agnostic CRUD path dispatches on `card.kind`.

**SQLite mapping (the 06a default backend) — DECISION:**
1. **Widen `memories.target` CHECK** to `IN ('memory', 'user', 'failure',
   'knowledge')` (additive migration; existing rows unaffected). `Card.kind` →
   `memories.target`.
2. **Add a nullable `frontmatter TEXT` (JSON) column** to `memories`. It holds
   `Card.frontmatter` for kinds whose metadata has no dedicated column
   (knowledge-cards: the whole decoded envelope). For memory-cards it is **NULL**
   — their metadata already lives in the dedicated columns (`category`,
   `failure_reason`, `state`, `severity`, `pin`, …), unchanged byte-for-byte.
   This keeps memory-cards regression-green and gives knowledge-cards a
   round-trippable home without churning the memory schema.
3. Field map: `Card.id` → `memories.md_id` (the existing UNIQUE join key);
   `Card.content` → `memories.content` (+ `memory_fts` FTS5 for free via the
   existing triggers); `Card.kind` → `memories.target`; `Card.frontmatter` →
   `memories.frontmatter` (JSON, knowledge only); `embed?`/`graph?` → **not
   persisted in 06a** (reconstitute as `undefined` on retrieve).

**SurrealDB mapping (graph) — placeholder in 06a:** knowledge-cards round-trip
through SQLite only in 06a. The Surreal backend's graph-augmented recall
(`RELATE` edges, `backfillGraphEdges`) is memory-target-specific today; for
knowledge it is a **no-op** in 06a — `Card.graph` is held on the object but not
indexed into Surreal graph edges. **Flagged for ticket 03 (graph) / 06b**
(orchestrator) / 04 (embed): a later task makes Surreal the graph+embed home for
knowledge-cards. 06a must not regress the Surreal memory path.

**Backend selection unchanged:** `createBackendBundleWithFallback` (SQLite
default → SurrealDB graph) stays as-is; knowledge-cards just ride the SQLite
path in 06a. No new backend is introduced.

### 8. Coexistence (regression guarantee)
- Memory-cards keep their current section-md files (`.agents/memory/*.md`), their
  current codec (`memory-format.ts`, extracted-but-unchanged), their current DB
  columns, and their current dedup primitives. The `MemorySerializer` IS the
  extracted existing logic — a relocation, verified byte-identical.
- Knowledge-cards are a NEW kind with their OWN serializer/dedup-strategy; they
  do not touch memory files, memory columns (beyond the additive `target` widen
  + nullable `frontmatter`), or memory dedup.
- **No migration.** Memory-cards are NOT moved into `kind:"memory"` typed rows
  by 06a — they stay exactly as they are. Migration is ticket 13 (migrate at
  graduation), gated on this store being built + proven on knowledge-cards first
  (per ticket 05 fork 1).

## Acceptance (06a)
1. **Knowledge round-trip:** ingest the existing vault-md knowledge-graph corpus
   into the card-agnostic store via `KnowledgeSerializer` (deserialize each vault
   `.md` → `Card`, persist via the kind-agnostic store); retrieve them back;
   assert `id`, `kind`, `content`, `frontmatter` are preserved end-to-end through
   the SQLite backend.
2. **Memory regression:** the FULL existing hermes test suite stays green
   (memory/user/failure cards unchanged byte-for-byte; the extracted
   `MemorySerializer` is byte-identical to the prior inline logic).
3. **zk primitives unchanged:** the 4 zk functions
   (`collectInputFiles`/`ingestRecords`/`runConvergenceLoop`/`retrieveRecords`)
   are NOT modified — they keep writing vault-md. 06a only adds the store's
   ability to READ/HOLD knowledge-cards. No zk code changes.
4. **Dedup idempotency:** re-ingesting the same knowledge corpus twice produces
   no duplicate rows (`KnowledgeDedupStrategy` → `skip` on id-match).

## Out of scope (explicit — other tickets / 06b)
- **06b (spine orchestrator):** `ingestPath(dir|file)` / `walkAndIngest`
  (directory-walk + type-dispatch policy), the zk→store mirror wiring
  (`KnowledgePipeline` seam consumption driving live ingest), the embed index,
  drift hooks (Tier 1/2/3 sync), memory-card migration.
- **Ticket 04:** embed backend (nomic-embed-text-v1.5 via LM Studio; SurrealDB
  native PRIMARY, sqlite-vec fallback) — `Card.embed` is typed but not
  populated/indexed in 06a.
- **Ticket 03:** two-layer knowledge graph (wiki-link + typed entity-relation;
  SurrealDB `RELATE` edges / derived index) — `Card.graph` is populated on the
  object by `KnowledgeSerializer` but not indexed/persisted to graph edges in 06a.
- **Ticket 05:** DB↔md drift field-classification policy (Tier 1/2/3 +
  merge-plan conflict surfacing) — 06a does not wire drift hooks.
- **Ticket 13:** memory-card migration into the unified store (migrate at
  graduation; blocked by 06).
- **Ticket 07/08/09/10:** image-card, planning-card model, planning-sync,
  staleness — unrelated to the store core.

## Open questions for 06b (flag for review)
1. **`Card.embed` typed shape.** Left `unknown` in 06a. 04 decides the vector
   store (SurrealDB native vs sqlite-vec fallback) + dim (768). 06b pins the
   concrete type (`Float32Array` vs a backend-specific handle). — resolvable from
   04.
2. **`memories.frontmatter` JSON column vs a dedicated knowledge table.** 06a
   adds one nullable JSON column for simplicity (additive, low-risk). If 06b finds
   knowledge-cards query a stable frontmatter sub-field often (e.g. `status`,
   `record_type`), it may promote hot fields to columns or split a parallel
   `knowledge_cards` table. — defer the measurement to 06b.
3. **`KnowledgeSerializer.serialize` write-back.** 06a provides it for symmetry
   but the store does not call it (zk owns vault writes). 06b decides whether the
   orchestrator ever writes knowledge-cards back through the serializer (e.g. a
   dedup-merge mutating a canonical card) or vault writes always stay zk-owned.
4. **SurrealDB knowledge persistence.** 06a is SQLite-only for knowledge. 06b (+
   03/04) decides whether knowledge-cards ever land in Surreal at all, or whether
   Surreal stays graph/embed-only (memory CRUD stays SQLite either way).
5. **Does the store need a kind-agnostic `query`/`search` over Cards today?** 06a
   focuses on ingest/round-trip. A `searchCards(query, {kind?})` over `memory_fts`
   is implied but not required by the acceptance — flag for 06b if the
   orchestrator's RAG path needs it before the embed index exists.
