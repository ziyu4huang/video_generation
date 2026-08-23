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
