# kcard resource tier — spec

Effort: `.planning/2026-08-25-kcard-resource-tier/` (map: `map.md`). Synthesized from the 2026-08-25 dual exploration (upstream `~/proj/OpenViking` clone + repo knowledge-layer survey) and the user's direction choice (build inside kcard).

## Problem Statement

An agent working over a large document corpus in the vault (a spec folder, a docs tree, file2md output) cannot retrieve from it usefully. The only ingestion path (`zk_ingest --source generic`) makes one thin card per file — measured on the USB4 spec: 839 pages become `pattern` cards with junk summaries, no directory structure, no overview, and retrieval degrades to flat search over atomic noise. Upstream OpenViking solves exactly this with per-directory semantic tiers (L0 abstract / L1 overview / L2 detail) and directory-recursive retrieval; kcard deliberately took the card-centric Core-5 and deferred this.

## Solution

A **resource tier** inside s2-agent-ext-knowledge-card: point `resource-ingest` at a markdown tree; every file becomes an embedded L2 row in the existing `context_db`, every directory gets an LLM-generated L1 overview written as a `.overview.md` sidecar (bottom-up, deterministically sampled for huge directories) with an L0 abstract extracted from it (`.abstract.md`) — no second LLM call. All levels are embedded into a new `resource` table (HNSW + fingerprint-gated shadow rebuild, same build facts as the `card` index). `resource-query` answers a query the upstream way: a global L0/L1 vector pass seeds a best-first directory heap, children are searched scope-limited per directory, scores propagate parent→child, and results converge in ≤3 stable rounds. The USB4 corpus (839 pages, already converted and in the vault) is the demo and the eval baseline.

## User Stories

1. As an agent, I want to ingest a whole document tree with one command, so that I don't hand-pick files or accept one-card-per-file noise.
2. As an agent, I want each directory in an ingested tree to carry a short L0 abstract, so that I can judge relevance in ~100 tokens before reading anything.
3. As an agent, I want each directory to carry an L1 overview, so that I can plan which subtree to read without loading full files.
4. As an agent, I want files to stay individually retrievable (L2), so that exact facts remain reachable.
5. As an agent, I want search to return results with their directory context and a browse trajectory, so that a wrong result is explainable by path.
6. As an agent, I want tiered loading (ask for L0, promote to L1, then L2), so that token spend scales with need.
7. As a human (Obsidian user), I want `.abstract.md` / `.overview.md` sidecars visible in the vault, so that I can read and audit what the tier generator wrote.
8. As a maintainer, I want the resource index rebuildable from the tree alone, so that a model swap or DB wipe never loses knowledge.
9. As a maintainer, I want the zettel `card` lane and its D25-gated default untouched, so that resource-tier work cannot regress the existing retrieval baseline.
10. As a maintainer, I want an A/B gate on the USB4 corpus before any tool-surface wiring, so that the lane earns its surface the way hier did (parity D25/D27).

## Implementation Decisions

- **Storage**: new SCHEMALESS `resource` table in `context_db` (per-user ns, parity D6): `uri` (tree-relative), `level` (0|1|2), `name`, `abstract`, `vec` + `embed_model`, `created`, `updated`, `parent` (plain index), record key sha256(uri). Own HNSW (dim from embedder = 1024) and own schema-salted fingerprint in `index_meta`; full shadow-table rebuild + swap; vectors 6dp-rounded, 24-row batches (build facts, map Context).
- **Canonical source**: the on-disk md tree. Sidecars `.abstract.md`/`.overview.md` written into the tree (OKF-style frontmatter: `generated_by`, `freshness { total_entries, sampled_entries, pending_child_changes }`); DB rows re-derive from files.
- **L2**: embed = title + capped body prefix (existing cap discipline); abstract = deterministic first-sentence. No LLM.
- **L1**: one `chatJson` call per directory (existing kcard LLM seam, JSON fast path), inputs = child abstracts + child-dir L0s; deterministic sample above a measured child bound; generated bottom-up (leaves → root).
- **L0**: paragraph-extraction from L1 (between H1 and first `##`), size-clamped. Never a second LLM call.
- **Retrieval**: global KNN over level∈{0,1} seeds a max-heap of directories; per-round pop ≤4 dirs, KNN scoped `WHERE parent = $uri AND level` for direct children; combine `α·child + (1−α)·parent`; only directory rows re-enqueue; stop on ≤3 unchanged-top-k rounds or 3 stagnant rounds. Pure deterministic (no reranker, no intent stage — parity D19 posture). Separate query lane + CLI; no change to `retrieveRecords` defaults.
- **Surface**: `s2-agent cli resource-ingest <dir>` and `resource-query <q>` (zk-ingest CLI precedent); `zk_fs`/tool wiring deferred to the post-gate ticket.
- **Naming**: domain vocabulary follows upstream where it collides with this tier (L0/L1/L2, abstract, overview, resource) and the kcard glossary elsewhere; a cross-package naming-alignment pass is tracked OUTSIDE this effort (next-goal item, 2026-08-25 user).

## Testing Decisions

- Unit: tier extraction (L0-from-L1 paragraph clamp), sampling determinism, uri/key derivation, fingerprint salting — hermetic, no live services; `_testEmbedder` pattern (hermeticity trap from parity D36 stays honored).
- Index build/rebuild: temp Surreal ns + scratch db (NEVER the live `context_db` — PR #2008 receipt lesson); skip-under-CI tripwire mirroring `eval-gate.test.ts`.
- Retrieval: fixture corpus (tree of ~20 files, 3 levels) asserting heap order, propagation arithmetic, convergence, and type of returned trajectories; golden-shape on the query result contract.
- L1 generation: mock the LLM seam; assert prompt carries child abstracts + L0s, bottom-up order, and freshness-counter increments; one live-LLM smoke on a small real dir (on-demand, not CI).
- Eval gate (ticket 04): ~20 USB4 questions (English, derived from spec section content), hit@5 + MRR, three arms: resource-tier vs flat generic-cards (scaled to same corpus) vs card-hier baseline arm for reference; run twice, record numbers in the ticket receipt; independent reviewer subagent per build ticket.

## Out of Scope

- Re-implementing or touching the zettel `card` lane defaults, hotness, or extract loop (parity D36/D39/D41 hold).
- Upstream peripherals: reranker, sparse/hybrid vectors, QueueFS persistence, path locks, snapshots, multi-tenancy, cuVS, Web Studio, cloud adapters, session extraction.
- `kcard://`/`viking://` URI scheme (parity D33 stands — tree-relative paths are the URIs).
- Non-markdown ingestion (file2md remains the converter front-door; this tier consumes its output).
- Cross-package feature/naming alignment beyond this tier's own vocabulary (tracked as a next-goal item, not a ticket here).

## Further Notes

- The flat-839-page directory problem: the USB4 pages/ dir has no chapter structure; ticket 02 measures whether a sampled single L1 stays useful or the ingest needs a TOC-derived chapter segmentation layer (Fog of war, map).
- Sidecars must not confuse file2md resumability (manifest is page-scoped) — verified in ticket 02, flagged in Fog of war.
- bge-m3 embeds ~839 files ≈ 27 batches ≈ the morning's 71-row rebuild scale ×12 — index rebuild time measured in ticket 01, kill-switch `KCARD_INDEX_REBUILD=0` semantics reused.
- AGPL: upstream is AGPLv3 — we port ALGORITHMS and prompt SHAPES by re-implementation in original TS under the repo license, never copy code (user directive: "learning from, not directly copy").
