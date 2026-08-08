type: grilling
blocked by: 01

## Question

The knowledge-graph has TWO layers (per grilling): a wiki-link layer and a typed entity-relation layer; the LLM entity-relation extraction is OPT-OUT (a speed/low-quality mode that skips it).

Pin the spec:
- **Wiki-link layer**: deterministic auto-linking rules — when does ingest insert a [[link]]? Shared topic-key? Shared entities? Shared source-file? Define the rule precisely so it is reproducible without an LLM. Builds on zk's existing wiki-link graph + MOC.
- **Entity-relation layer**: typed edges subject -> relation -> object. What relation schema (a fixed type set? free-form?)? Where do edges live — inline in card frontmatter, a separate DB table/index, or both? How are they queried?
- **Opt-out contract**: a single flag (e.g. kg.llm=false / env PI_KG_LLM=0) that disables LLM extraction and falls back to wiki-link-only. Define exactly what is skipped and what still runs.
- **Storage split across backends**: how the graph (links + relations) is represented in md (obsidian) vs indexed in SQLite (FTS + sqlite-vec) vs SurrealDB (native graph/embed).

Blocked by 01 (needs the card-agnostic card model to know what a card and its frontmatter are). Grilling, one fork at a time.

## Resolution (2026-08-08, grilled)

Two-layer knowledge graph pinned. **Reframe:** the wiki-link layer + deterministic entity extraction ALREADY EXIST in knowledge-card (deterministic, zero LLM — `entities.ts:12` rejects LLM at ingest). The real design work was the typed entity-RELATION layer (which did not exist anywhere) + the storage split + the LLM toggle.

- **Fork 1 (wiki-link layer) — FORMALIZE AS-IS:** the existing deterministic shared-tag rule IS the spec: `scoreOverlap` over shared-tag sets (`count` default or `idf` mode), top-`maxLinks`(20) neighbors -> `## 連結` `- 相關：[[<slug>]]` + MOC (`Tags/Knowledge Graph.md`) + obsidian VaultIndex (backlinks/dead-links/orphans). NO expansion to shared-entities/source-file — clean layer separation (entities stay in the typed-relation layer; source-file is a weak/noisy signal).
- **Fork 2.1 (typed-relation storage) — md source-of-truth + derived index:** typed `subject->relation->object` edges live in card frontmatter (`relations: [{s, rel, o}]`) as the canonical source, with a DERIVED query index (in-memory rebuild like the wiki-link VaultIndex at small scale; persistent DB index at scale — SurrealDB `RELATE` / SQLite relations-table, per backend). Mirrors the wiki-link layer pattern. md<->DB sync drift -> ticket 05. Consistent with the carry-over (graph index -> SurrealDB; SQLite non-embed CRUD).
- **Fork 2.2 (relation schema) — HYBRID:** a small enumerated core of high-value relations (references, depends-on, extends, contradicts, supersedes, implements) for predictable querying/aggregation, PLUS free-form string predicates for domain-specific relations. Natural fit for LLM extraction (varied predicates) while keeping the common case queryable.
- **Fork 3 (LLM opt-out) — OPT-IN (default OFF):** single coarse flag `kg.llm` (config) / `PI_KG_LLM` (env override). DEFAULT OFF -> graph = deterministic layers only (wiki-links + regex entity tags + MOC + heal) — zero LLM at ingest. ON (`kg.llm=true`) -> + LLM typed-relation extraction writes `relations:` frontmatter -> derived index. Flips the ticket's literal "opt-out" text: per-card LLM at ingest is costly+slow at scale; matches the codebase's deterministic-by-design philosophy + VLM/embed opt-in pattern (tickets 04/07).
- **Fork 4 (storage split) — COLLAPSED:** the carry-over already decides it (embed -> SurrealDB-only + lm-studio; SQLite non-embed CRUD only). The only open storage question was where typed relations live — answered in fork 2.1 (md source + DB-derived). Wiki-links stay md-native (existing).

**Interface impact (task 12):** `KnowledgePipeline.retrieveRecords` returns typed edges (parsed from md or served from the derived index); `ingestRecords` may write `relations:` frontmatter when `kg.llm` is on. No new primitive strictly required (relations ride the existing retrieve/ingest surface), though a `queryRelations` helper may emerge during impl.

**Note:** closing 03 does NOT unblock task 12 — `04` (embed backend) is still open and also blocks 12.

closed: implemented-as-decision (two-layer graph contract pinned).
