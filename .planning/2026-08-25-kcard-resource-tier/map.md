---
effort: kcard-resource-tier
created: 2026-08-25
last: 2026-08-25
status: active
---

# kcard resource tier — document-tree L0/L1/L2 (the OpenViking resource model) on the kcard Surreal index

## Destination

Large document corpora (file2md output trees, spec folders, repo docs) ingest into kcard as a **resource tier**: every file becomes an L2 row, every directory gets an LLM-generated L1 overview and an extracted L0 abstract (bottom-up), all embedded and indexed in the existing `context_db` SurrealDB alongside (but separate from) zettel `card` rows, and retrievable through OpenViking-style directory-recursive search (global L0/L1 pass → best-first heap descent with score propagation). The USB4 spec (839 converted pages, live in the vault) demos it end-to-end and is the eval corpus.

## Context

- **The Core-5 already landed** (effort `2026-08-23-kcard-openviking-parity`, D1–D41): `zk_fs` virtual FS, `card` table + HNSW@1024 + FTS in `context_db`, `hierarchical-retrieval.ts` (KNN+FTS seeds, client-side BFS max-propagation γ=0.5), hotness/usage ledger, extract loop. Measured gate: hier 17/20 hit@5 MRR 0.700 vs flat 0.688; default switch live (#1934). Successor `2026-08-24-kcard-production-hardening` CLOSED (queue drained; two dormant triggers).
- **Two gaps remain vs upstream OpenViking** (measured against the local clone `~/proj/OpenViking` 2026-08-25): (1) **no directory-level LLM semantic tiers** — kcard's tier-ladder is per-card demote-not-truncate and agg nodes are deterministic aggregations; upstream generates per-directory `.abstract.md` (L0) + `.overview.md` (L1) bottom-up with L0 extracted from L1's first paragraph, never a second LLM call (`semantic_processor.py:1102`); (2) **no document-tree ingestion** — `zk_ingest --source generic` is one-card-per-file, measured 2026-08-25 on the USB4 corpus: 839 pages → thin `pattern` cards, `created: 1970-01-01`, summaries polluted by page-header copyright lines (memory: file2md-kcard-pipeline-verified).
- **Upstream minimal subset** (explored, same session): one table `uri/level/vector/abstract` + L2 embed-on-ingest + per-directory LLM overview + heap-recursive retrieval (~150 lines, `_recursive_search` at `hierarchical_retriever.py:396`). Skip: reranker, sparse vectors, QueueFS, path locks, multi-tenancy, cuVS, session extraction (kcard has it).
- **SurrealDB 3.2.3 build facts hold** (parity ticket 03, live-probed): HNSW works on SCHEMALESS fields @1024-dim COSINE; KNN `<|k,ef|>` only; server-side recursion times out → client-side BFS; `/sql` body cap 1 MiB → 24-row batches, vectors rounded 6dp; record key sha256(stem); FTS single-column.
- **User direction confirmed 2026-08-25** (AskUserQuestion): build INSIDE kcard as a resource tier — not a standalone ext, not an upstream deployment.
- Live scale: 71 cards in `context_db` (61 parity-era + 10 USB4 generic test cards ingested 2026-08-25 morning); parity scale trigger is 1,500.

## Tickets

### Phase 1 — index + L2
- [01] `resource` table + document-tree L2 ingest — closed 2026-08-25 (implemented; receipts in the ticket)
### Phase 2 — semantic tiers
- [02] directory L1 overview + L0 abstract generation (bottom-up, sampled) — open (blocked by 01)
### Phase 3 — retrieval
- [03] directory-recursive retrieval lane over resource rows — open (blocked by 02)
### Phase 4 — proof + surface
- [04] USB4 eval gate: resource-tier vs flat generic-card A/B — open (blocked by 03)
- [05] tool/CLI surface + effort close-out — open (blocked by 04)

**Execution order:** 01 → 02 → 03 → 04 → 05 (fully forced by blocking edges; single lane).

## Decisions

- **D1 — scope = the two measured gaps, nothing more.** Document-tree resource ingestion + directory-level L0/L1 semantic tiers + the recursive lane over them. NOT re-done: Core-5 (parity D1), hotness, extraction, `zk_fs` shape. Upstream peripherals stay out (parity D1 list holds). Reason: the MVP ask ("embedding OpenViking on SurrealDB") is already 80% landed; this effort is the remaining 20% the USB4 test case exposed.
- **D2 — new `resource` table in the existing `context_db`; zettel `card` untouched.** Different unit of knowledge (file/directory row vs atomic zettel), different lifecycle (source-tree-derived vs curated). Columns: `uri` (tree-relative path), `level` (0|1|2), `name`, `abstract`, `vec`, `embed_model`, `created/updated`. Record key sha256(uri) (parity ticket-07 fact: CJK/backtick stems). Separate HNSW + fingerprint (schema-salted, INDEX_SCHEMA_VERSION precedent) — a resource rebuild never touches the `card` freshness gate. Reason: parity D9's single-table rationale (one-hop KNN over one unit type) applies per table; mixing files into `card` would pollute zettel semantics and the D25-gated default lane.
- **D3 — the source md tree is canonical; SurrealDB rows are derived (parity D2 analog).** The file2md output tree on disk is the source of truth; a content-hash fingerprint gates full shadow rebuild + swap (parity D13 shape). L0/L1 sidecars are WRITTEN into the source tree as `.abstract.md` / `.overview.md` (OpenViking OKF convention: frontmatter `generated_by` + `freshness` counters) — they are regenerable artifacts, human-browsable in Obsidian, and the DB re-derives from them. Reason: upstream convention + the vault IS the Obsidian vault (sidecars make tiers inspectable); regenerable-with-counters avoids the sidecar rejection rationale of parity D7 (which was about CARDS, whose canonical md is hand-authored — resource trees are machine-derived).
- **D4 — L2 embeds the file body (capped), abstract = deterministic first-sentence.** Embed text = title + first N body chars (parity semantic.ts precedent, cap ~1000); abstract = `firstSentenceSummary` (existing deterministic helper) — NO per-file LLM call. Reason: 839 pages × LLM = the exact cost upstream's per-file summary tier exists to avoid at MVP scale; bge-m3 via the existing `embedding-leaf` seam (D8 parity config chain), 1024-dim.
- **D5 — L1 is one LLM call per directory, bottom-up, deterministically sampled for large dirs.** Inputs = child file abstracts + child-dir L0s; `chatJson` (existing kcard LLM seam, `reasoning_effort:"none"` fast path) with the upstream `overview_generation.yaml` prompt shape; deterministic sample when children exceed a bound (upstream `deterministic_sample`, batching at ~large-dir threshold — exact bound measured in ticket 02). **L0 = extracted from L1** (paragraph between H1 and first `##`), never a second call (upstream `semantic_processor.py:1102`). Reason: the token-economics core of the whole tier system.
- **D6 — retrieval = the upstream heap algorithm over `resource` rows, as a SEPARATE lane.** Global L0/L1 KNN pass seeds a best-first dir heap; child expansion = KNN scoped to `parent = $uri` (depth-1, plain index); propagation `α·child + (1−α)·parent` (α measured in ticket 03, upstream default shape); only L0/L1 children re-enqueue; ≤3 convergence rounds (parity D20's client-side BFS + upstream `_recursive_search` both agree). The `card` lane's default (parity D36) is untouched; no default switch without a D25-style gate. Reason: parity D19 deterministic posture holds (no reranker, no intent analyzer).
- **D7 — MVP surface = CLI first (`s2-agent cli resource-ingest` + `resource-query`), tool wiring is ticket 05.** zk-ingest CLI precedent (this morning's verification used it live); `zk_fs` op extension only after the eval gate proves the lane. Reason: schema-cost discipline (parity D32 rationale) — one gate family at a time.
- **D8 — eval gate (parity D14/D25 discipline): USB4 question set, resource-tier vs this morning's flat generic-card path.** ~20 questions answerable from the spec (written from the spec's own section content, English); metrics hit@k + MRR; a fresh generic-card arm is the baseline (10-card morning ingest scales to the same chapters). Independent reviewer subagent per build ticket (parity D14). Reason: no default/tool surface without beating the cheap baseline.

## Frontier

Ticket 02 — directory L1 overview + L0 abstract generation: ticket 01 landed the `resource` table + L2 ingest (840 USB4 rows, delta-embedding contract, flat KNN live); the semantic tiers are the next readers of those rows and the input ticket 03's recursion descends through.

## Fog of war

- Sampling bound + token budget for L1 over an 839-child directory (the USB4 pages/ dir is flat) — measure in ticket 02; upstream batches/merges, we may need chapter-level grouping (page-number → chapter segmentation from the spec TOC) if a single L1 can't hold a sampled 839-file dir usefully.
- Whether L0/L1 sidecars inside a file2md output tree confuse file2md's resumability (page-status manifest ignores non-page files — expected safe; verify in ticket 02).
- α (score propagation) and the L0/L1-seed-vs-L2-only ablation — measure in ticket 03/04.
- Whether `zk_ask`'s graph-RAG turn-limit fallback (observed 2026-08-25 morning) interacts with the resource lane — out of scope here, recorded in the morning's next-goal.

## Cross-effort links

- **Builds-on:** `2026-08-23-kcard-openviking-parity` (Core-5 + SurrealDB build facts; this effort fills its two remaining gaps). Back-link added there.
- **Builds-on:** `2026-08-24-kcard-production-hardening` (fingerprint freshness gate + shadow-rebuild automation this effort reuses). Back-link added there.
- **Shares-decision-with:** `2026-08-22-context-lifecycle` (embedding model D3 bge-m3 via the `__piEmbeddingConfig` seam; unchanged here).
- Evidence source: 2026-08-25 morning file2md→kcard pipeline verification (output/next-goal-20260825-111500.md) — the USB4 corpus, its generic-card baseline, and the measured gaps are this effort's seed evidence.
