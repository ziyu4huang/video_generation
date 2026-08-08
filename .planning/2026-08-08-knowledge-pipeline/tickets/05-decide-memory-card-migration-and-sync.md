---
type: grilling
blocked by: 01
status: closed
---
# 05 — Memory-card migration + DB↔md drift policy

## Question

Two transition decisions once the card-agnostic store (01) is defined:

- **Memory-card migration**: do existing hermes section-md memory-cards get migrated into the card-agnostic store now (typed kind: memory), or do they COEXIST (memory stays on the old path, knowledge on the new) during this effort? Trade-off: migration = one store sooner but risk to the working memory system; coexist = safe, two paths until a later migration. (Bulk MEMORY.md to knowledge-card rewrite is explicitly out of scope; this is only about the store, not the content shape.)
- **DB<->md bidirectional sync conflicts**: md is canonical (decided). Define what happens on drift — e.g. a card edited in md after its DB mirror, or a DB-only field with no md representation. Re-gen-from-md? Last-write-wins with a warning? Conflict-surfacing merge-plan (zk/merge-plan.ts exists)? Pin the resolution policy, especially for knowledge-cards whose graph edges may live DB-side.

Blocked by 01 (the card-agnostic schema determines both the migration target and the sync field set). Grilling, one fork at a time.

## Resolution (2026-08-08, grilled)

Migration timing + DB↔md drift policy pinned. Both forks resolve to "extend hermes's existing discipline to knowledge-cards" — the unified store inherits the proven md-canonical pattern rather than a parallel mechanism.

- **Fork 1 (migration) — MIGRATE AT GRADUATION (coexist during build):** memory-cards COEXIST on hermes's current proven section-md path while the card-agnostic store is built and stabilized on *knowledge*-cards first; the memory-cards move into the unified store as the FINAL milestone before this effort closes. Rationale: `map.md`'s destination is a single card-agnostic store, so permanent coexistence would contradict the goal — the real choice is *when* to migrate, not whether. Migrating eagerly (the moment the store stands up) would risk the live memory system before the new store is battle-tested. Migration is mechanical and low-risk *when the time comes* — `01` already guarantees kind-agnostic storage via a pluggable serializer (`kind: memory` slot), so delaying it is cost-free. Tracked as task ticket 13 (blocked by 06).

- **Fork 2 (DB↔md drift) — FIELD-CLASSIFICATION POLICY (3 tiers + merge-plan for genuine conflicts):** drift resolves by field class, reusing hermes's existing primitives. Drift signal = per-card content-hash (reuse `merge-plan.ts`'s `hashEntry` / `snapshotBaseHash`), gated so unchanged cards aren't re-indexed.
  - **Tier 1 — md-canonical (mirrored):** content + frontmatter (`id`, `created`, `category`, `state`, `severity`, `pin`, `relations:`, `supersedes`). md wins → re-index md→db (extend `syncMarkdownMemories` to knowledge-cards). No merge.
  - **Tier 2 — derived cache:** embed vectors, FTS indexes, graph index tables (`tag`/`tagged`), surrogate keys. Auto-re-generate from md — staleness, not conflict; never written back to md.
  - **Tier 3 — DB-authoritative (opt-in):** worth-scoring counters, `used_at`, session-assembly hashes. Stay DB-side, explicit opt-in, NO md write-through — the proven `worth-scoring` precedent. This answers "a DB-only field with no md representation": it's operational metadata by design, not knowledge content; it needs no md home.
  - **Conflict (rare) — merge-plan:** only DB-CRUD that mutates *md-canonical content* (e.g. a dedup-merge of two knowledge-cards) surfaces a merge-plan. Reuse `merge-plan.ts`'s `hashEntry` / `snapshotBaseHash` / `baseHashMatched` optimistic-concurrency; agent/user resolves — no silent last-write-wins.

**Why not the alternatives:** global last-write-wins silently drops Tier 2 (embed vectors) + Tier 3 (worth-scoring) on every md edit — data loss. Blind re-gen-from-md for everything wastes recompute on unchanged cards and must NOT touch Tier 3. The 3-tier policy codifies what hermes already ships.

**Prior-art correction:** the ticket cited `zk/merge-plan.ts`; it actually lives in **hermes** (`pi-agent-ext-hermes-memory/src/store/merge-plan.ts`) and is an LLM-driven *consolidation* merge (drop/merge by content-hash), not a drift-conflict resolver. We reuse its hash + optimistic-concurrency primitives; the conflict *model* (tier classification) is new.

**Interface impact (task 12):** the `KnowledgePipeline` ingest/upsert path hooks into Tier 1 (re-index on md-hash change) + Tier 2 (re-derive embed/graph cache); Tier 3 fields are hermes-internal, not exposed on the cross-extension seam. Specializes for `.planning/` in ticket 09 (blocked by 08).

closed: implemented-as-decision (migration timing + drift policy pinned); impl task = 13 (migration milestone), store build gated by task 12.
