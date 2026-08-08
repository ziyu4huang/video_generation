type: grilling
claimed: claude (inline, 2026-08-08)
blocked by:

## Question

hermes-memory becomes the LOW-level card-agnostic store; zk becomes the HIGH-level knowledge layer; no duplication. Today they overlap: hermes owns the MemoryRepository/Backend contract + MD<->DB sync over section-md memory-cards; zk owns obsidian-md knowledge-cards with its own persistence + 4-layer dedup + graph.

Pin the exact contract between them:
- **Card-agnostic schema**: how does hermes's store generalize to hold BOTH memory-cards and knowledge-cards? A type/kind discriminator? A unified frontmatter schema with flavor-specific optional fields? What is the stable id to DB-column join key (today: frontmatter id to md_id)?
- **What moves down**: which of zk's currently-duplicated responsibilities (persistence, DB mirror, dedup gating) delegate into hermes vs stay in zk as high-level logic?
- **What stays split**: zk keeps obsidian-md card FILE ops + graph + ingest orchestration; hermes owns the store/DB-accel contract. Confirm the seam.
- **Format coexistence**: knowledge-cards live as obsidian-md in the vault; memory-cards as section-md in .agents/memory/. Does the card-agnostic store abstract over BOTH file backings, or do knowledge-cards also adopt a hermes-managed md location?

This is the foundational refactor decision — 03, 04, 05 (and all downstream implementation) hang on it. Grilling, one fork at a time.

## Resolution (closed 2026-08-08)

Grilled two forks; contract pinned.

**Card model** — one unified `Card { id, kind: "memory"|"knowledge", content, frontmatter, embed?, graph? }`. The hermes store is kind-agnostic (CRUD / query / dedup / embed over Card). A pluggable **serializer** per kind owns disk serialization + location:
- `kind: memory` -> section-delimited entry in `.agents/memory/*.md` (hermes's existing format) — unchanged.
- `kind: knowledge` -> obsidian-md file in the vault (zk's existing format) — unchanged.
The store abstracts over both file backings via the serializer interface; no format migration required.

**Seam — what moves DOWN to hermes / stays HIGH in zk:**
- DOWN to hermes store: persistence, DB mirror (backend-ab SQLite + SurrealDB), **dedup/conflict call-site + default strategy**, embed index, query.
- HIGH in zk: card semantics, the two-layer graph (wiki-link + entity-relation), ingest orchestration (file extractors -> cards), `zk_ask` blend/RAG, and the **knowledge-kind dedup strategy** (zk's 4-layer logic, registered into the store's strategy interface).

**Dedup / conflict** — ONE call-site in the store behind a **pluggable strategy interface**. Default strategy = the existing exact / near-dup / topic / merge-plan (card-agnostic, from the prior effort). zk registers its 4-layer logic as the `kind: knowledge` strategy. One call site (no duplication), kind-specific richness preserved. _Cross-effort note: this also resolves the prior effort's (2026-08-07) open dedup-location question — dedup/conflict is PROMOTED into the store contract (no longer MD-layer-only, no more blind `addMemory` double-persist), implemented as a strategy seam._

**id <-> DB join key** — unchanged: `Card.id` <-> DB column `md_id`.

Downstream: 03 (graph) and 04 (embed + ChromaDB) now have the card model + strategy seam; 05 (migration/sync) sees a card-agnostic store with per-kind serializers, so memory-cards adopt `kind: memory` in place (coexistence is the natural default — no migration needed for 05's answer).

closed: 2026-08-08 (unified card-agnostic store contract pinned; unblocks 03/04/05)
