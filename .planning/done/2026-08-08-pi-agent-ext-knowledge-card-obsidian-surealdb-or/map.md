---
effort: 2026-08-08-pi-agent-ext-knowledge-card-obsidian-surealdb-or
status: complete
---

## Destination

A layered, reuse-based knowledge pipeline that turns arbitrary text-extractable files into a git-trackable knowledge graph — generalizing the existing memory mechanism so input is no longer just "memory" but any file (a file, a batch, or a whole directory the agent walks).

Architecture (extend existing, NOT greenfield):

    [any text file: md/txt/pdf/docx/pptx]   <- OCR/photos deferred
            |  file-ingest front-end (zk high-level: zk_ingest + extractors)
            v
      zk knowledge-cards  (high level: ingest, 4-layer dedup, two-layer graph)
            |  delegates persistence + DB-accel to v
            v
      hermes card-agnostic store  (low level: MD-canonical + backend-ab)
            |  SQLite (FTS5 + sqlite-vec)  |  SurrealDB (native embed)   <- A/B picks default
            v
      obsidian vault on disk  (md cards + wiki-link graph; git-trackable)

Graph is two layers: wiki-links (deterministic auto-link, obsidian-native) + typed entity-relation edges (LLM extraction, OPT-OUT for a speed/low-quality mode). DB<->md is bidirectional with md canonical. Validated end-to-end against /Users/huangziyu/proj/study-news/content.

## Notes

Grilling decisions (2026-08-08, pinned destination+scope):
- Reuse/extend the three existing systems; NOT greenfield.
- DB: develop BOTH SQLite and SurrealDB with embeddings; pick default by A/B measurement (mirrors prior effort backend-ab). User: "develop both, I want the AB test number, we always have choice."
- Layering: hermes-memory = LOW level (store/repository/MD<->DB), zk = HIGH level (card/graph/ingest); no duplication.
- Card format: hermes store generalizes to card-agnostic (holds memory OR knowledge cards via a type discriminator); one store contract, two flavors.
- Graph: BOTH layers — wiki-links + typed entity-relation; LLM extraction opt-out for speed.
- Input MVP: text-extractable first (md/txt/pdf/docx/pptx); image OCR/photos deferred.

Carried context (prior effort 2026-08-07-how-is-current-memory-finding-duplicate-conflict):
- hermes already has SQLite + SurrealDB behind one MemoryRepository/Backend contract (src/store/repository.ts, backend-factory.ts); live-swap proxy swappable.ts; SQLite default, SurrealDB opt-in.
- Ticket 06: SurrealDB 10-50x slower than SQLite on p95 FTS search -> kept SQLite (for MEMORY). This effort's A/B is a different query mode (embed/semantic) so the prior number does not pre-decide.
- MD is canonical source of truth; DB mirrors via syncMemoryEntry. Dedup/conflict are MD-layer today.

Existing assets (reused, not rebuilt):
- pi-agent-ext-knowledge-card (zk, ~1500 lines): zk_card (CRUD + 4-layer dedup), zk_ask (graph-RAG, blend modes), zk_ingest (.knowledge.jsonl->cards), knowledge_query (tag digest); wiki-link graph + MOC; embed via obsidian.
- pi-agent-ext-obsidian (~2100 lines): vault CRUD + semantic_search (ChromaDB/vault-mind) + graph ops (neighbors/orphans/dead-links) + trigram search.
- pi-agent-ext-hermes-memory: memory-card (section-md, git-trackable) + backend-ab store.

Environment:
- Test corpus: /Users/huangziyu/proj/study-news/content (local, expandable later).
- Embed model via lm-studio (local); exact model/dimension TBD in ticket 04.
- SurrealDB v3.2.3 @127.0.0.1:8000 (from prior effort 05).
- Branch is 3 commits behind origin/main — rebase before implementation.

## Decisions so far

<!-- one line per closed ticket; open tickets live under tickets/ -->
- [01-define-hermes-zk-layering-contract](tickets/01-define-hermes-zk-layering-contract.md) — unified `Card {id, kind, content, frontmatter, embed?, graph?}`; hermes store is kind-agnostic with pluggable per-kind serializer (memory->section-md, knowledge->obsidian-md, no migration); dedup/conflict = ONE store call-site with pluggable strategy (default=exact/near-dup/topic/merge-plan; zk registers its 4-layer for knowledge); persistence+DB-mirror+embed+query DOWN to hermes, graph+ingest+RAG HIGH in zk. Also resolves prior effort's dedup-location Q (promoted into store contract). Unblocks 03, 04, 05.
- [02-pick-file-ingest-extractors](tickets/02-pick-file-ingest-extractors.md) — research: md/txt native; pdf=mupdf via pi-agent-ext-file2md (AGPL, unpdf/MIT fallback); docx=mammoth; pptx=pptxtojson (MIT, new deps). Reuse: file2md already has proven extractPdfText() — ingest consumes its output (file2md=extractor layer, zk_ingest=card-formation). Chunk = one card per section/page/slide (~512 tok, ~64 overlap, never merge). Provenance frontmatter: source_file/format/extractor/ingested_at/content_hash/source_hash/locator/chunk_index/chunk_count. Caveat: isolated-linker requires every lib declared in kcard package.json.

## Not yet specified

- **Default backend (SQLite vs SurrealDB)** — can't decide until the embed A/B lands real numbers on the knowledge workload (mirrors prior effort 03-06). Graduates to a ticket after embed integration + A/B.
- **Implementation shape per layer** (generalized-store refactor, graph builder, embed wiring, obsidian sync, dir-walk agent) — these are DO-work, not DECIDE-work; they become a writing-plans effort once the decision tickets below resolve. Not pre-sliced here.
- **lm-studio embed model + dimension** — resolves inside ticket 04.

## Out of scope

- Image OCR / photos (deferred; text-extractable MVP only).
- Rewriting zk or obsidian from scratch (we extend/reuse both).
- Cross-repo / multi-vault graph federation.
- Bulk rewrite of the existing MEMORY.md corpus into knowledge-cards (coexistence/transition decided in ticket 05; bulk content migration is a later effort).

## Cross-effort links

- **Supersedes:** [2026-08-07-how-is-current-memory-finding-duplicate-conflict](../2026-08-07-how-is-current-memory-finding-duplicate-conflict/map.md) — generalizes that memory-only effort. Carries forward its locked decisions: SQLite perf win (06), near-dup threshold 0.6 -> ~0.3-0.4 (07), MD canonical, the MemoryRepository/Backend contract. The prior effort's open ticket 08 (dedup-location / source-of-truth / default-backend) is resolved by THIS effort's 01 (dedup promoted into store contract) + the A/B (backend); prior 08 closed as superseded.
- **Builds-on:** `2026-08-01-continue-improve-the-pipeline-between-extension-...` — that effort's CLOSED ingest decisions (deterministic `zk_ingest source:generic`, opt-in `knowledge` flag, `pi:knowledge` bus, file2md->hub emit contract) are the ingest design this effort's ticket 02 carries forward. That effort is superseded by this one (see its Absorbed-by link).
- **Shares-decision-with:** `perment-solve-these-issues-architecturely`/02 (single `hermes:<slug>` card namespace; `pi-memory:*` retired) — consistent with this effort's 01 (card-agnostic store + kind discriminator; no conflict).
- **Cites (embed prior art):** `2026-07-29-brainstorm-to-improve-pi-agent-ext-hermes-memory`/06 (sqlite-vec+MLX-local; SurrealDB-for-graph; ChromaDB OUT) + `2026-08-07-...`/06 (FTS: SQLite won) — detailed in ticket 04's Prior-art note.

---

> **SUPERSEDED-BY `2026-08-08-knowledge-pipeline`** (2026-08-08 unification). All 5 tickets (01-05) migrated verbatim to `.planning/2026-08-08-knowledge-pipeline/tickets/` (same numbers). This dir retains map.md + Decisions history only; live work continues in the canonical effort. See `.planning/2026-08-08-knowledge-pipeline/map.md`.
