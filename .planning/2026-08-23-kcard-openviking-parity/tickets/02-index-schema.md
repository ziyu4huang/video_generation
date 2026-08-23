# 02 — SurrealDB index schema for kcard

type: grilling
blocked by: 01 (client ownership decides where schema code lives)

## Question

Design the SurrealDB schema for kcard's derived index (D2: everything rebuildable from vault md). OpenViking's index carries `id, uri, parent_uri, context_type, is_leaf, vector, sparse_vector, abstract, name, description, created_at, active_count` — hierarchical metadata is first-class because directory-recursive retrieval needs it.

Questions to settle:

- Tables: one `card` table for leaves + agg/MOC nodes with `is_leaf` discriminator, or separate tables? Hierarchy as record links (`parent`) to map OpenViking's `parent_uri` recursion to graph traversal.
- Where do embeddings live — same table column vs separate `embedding` table (bge-m3 1024-dim; model-keyed like the existing JSON cache so an embed-model swap doesn't poison the index)?
- Relations index (frontmatter `relations:` from knowledge-pipeline D03) — `RELATE` edges vs plain table; does the >5k-rels scale trigger apply at 1925 cards?
- Hotness counters (`active_count`, timestamps) — in the index (derived, rebuildable from RecallLedger?) or only computed from the ledger?
- Regen story: hash-gated full rebuild vs incremental upsert; which fingerprint (existing semantic cache fingerprint pattern).

## Resolution (2026-08-23, grilling 1 round — CLOSED; all recommendations accepted, MVP stance)

Facts measured this session: agg nodes ARE vault md (`agg-L<layer>-<i>.md`, frontmatter `id/parent/entities/sources/layer/clusterSize/summary`, `kind: derived-aggregation` — `aggregation-write.ts`), so the entire tree is md-canonical and the index derives purely from files; hermes `schema.ts` precedent = SCHEMALESS tables + `DEFINE INDEX`; semantic cache fingerprint today = name+mtime per card, model-keyed path; `RecallLedger` does not exist yet (ticket 08 builds it); ticket 03 P5 proved one schemaless table holds leaf+agg under one HNSW.

All inside per-user ns / db `context_db` (D6). Layout:

```sql
DEFINE TABLE card SCHEMALESS;         -- leaves + agg nodes, one HNSW
DEFINE TABLE relation SCHEMALESS;     -- {s, rel, o} triples from frontmatter/pipeline
DEFINE TABLE usage SCHEMALESS;        -- append-only recall events (RecallLedger store)
DEFINE ANALYZER kcard_en TOKENIZERS class FILTERS snowball(english);
DEFINE INDEX card_fts ON TABLE card FIELDS title, summary FULLTEXT ANALYZER kcard_en;
-- HNSW: DEFINE INDEX card_vec ON TABLE card FIELDS vec HNSW DIMENSION 1024 DIST COSINE TYPE F32  (schemaless vec field — P1)
-- plain (non-unique) indexes on parent, is_leaf for the BFS lane
```

**D9 — one `card` table, `is_leaf` discriminator, record key = md filename stem** (`card:<slug>`): md↔db 1:1, rebuild idempotent; two tables would mean two HNSW indexes (double memory, merged KNN) for nothing. Fields: `path, title, summary, is_leaf, layer, parent (record link), entities, kind`. FTS on `title, summary` (L0/L1 surfaces), per-term queries merged client-side (P6 AND-only).

**D10 — `vec` (1024-dim F32) + `embed_model` as columns on `card`**: KNN returns full hierarchy fields in one hop; model-swap A/B safety comes from the shadow-db rebuild pattern, not dual-model coexistence; unchanged cards reuse the model-keyed JSON embedding cache.

**D11 — relations as a plain `relation(s, rel, o)` table**, not `RELATE` edges**: hermes `tagged` precedent; v1 retrieval is hierarchy BFS with no graph-walk consumers; md→index regen is unaffected if a later upgrade to `RELATE` happens. Current relation count unknown — measure in the build ticket (D03 >5k scale trigger).

**D12 — hotness: append-only `usage` table + aggregated `active_count`/`last_active_at` on `card`**: usage has no md counterpart, so `usage` IS the primary record (RecallLedger's store, built in ticket 08); md-driven rebuilds never wipe it and replay aggregates onto `card` after rebuild. Decay (sigmoid(log1p(active_count)) · exp, half-life 7d, bounded ≤±10% per context-lifecycle D8) computed at replay/periodic UPDATE time, never on the query path.

**D13 — regen = fingerprint-gated full shadow rebuild + swap**: fingerprint upgrades name+mtime → per-card content hash (mtime unreliable after git checkout); unchanged cards' vectors copied from the model-keyed cache (only new/changed cards embed); writes via the 1-MiB batcher (~100 cards/batch; 1925+326 ≈ 2.5 s measured); shadow-db swap on completion (P7: rebuild not reader-transparent). Chosen over incremental upsert: no intermediate states, no partial-failure repair logic, measured cost acceptable.

**D14 — execution constraint (user, this session): every build ticket ships with (a) an A/B test against the measured baseline — retrieval vs the 17/20 recall-audit (ticket 09 formalizes the gate), model/schema variants via shadow-db pairs — and (b) an independent reviewer subagent judging quality before merge (repo dispatch discipline: reviewer is the real quality gate, watchdog off).**
