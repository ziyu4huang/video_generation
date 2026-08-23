---
effort: 2026-08-23-kcard-openviking-parity
created: 2026-08-23
last: 2026-08-23
status: active
---

# kcard OpenViking parity — Core-5 on s2-agent-ext-* + Bun + SurrealDB

## Destination

`bun-apps/s2-agent-ext-knowledge-card` gains the core 80% of OpenViking's capability set — typed memory model, FS-style read surface, session-commit→memory extraction loop, hierarchical (directory-recursive) retrieval, and bounded hotness decay — implemented purely on this repo's stack: s2-agent-ext-* extension architecture + Bun + SurrealDB as a **derived, rebuildable index**. The vault markdown stays the sole canonical source. The map ends by handing off to `to-spec` for the build plan.

## Context

Measured 2026-08-23 in this worktree unless noted.

- **kcard today**: pure vault-markdown zettelkasten, **zero DB** (zero `surreal` matches in package). 1925 active cards, 326 agg nodes / 4 layers (real-vault receipts, PR #1848/#1854 era). 4 tools registered in `extensions/knowledge-card.ts` (~1400 lines): `zk_card`, `zk_ask`, `zk_ingest`, `knowledge_query`. Tier ladder L0/L1/L2 pre-rendered with demote-not-truncate (63.3% token cut/card, 65 vs 178 — ticket 07, PR #1854). Loads `static` in `s2-agent.registry.yaml` (lines 159–170).
- **Retrieval baseline to beat/hold**: recall-audit kcard hit@5 17/20, MRR 0.688, journal 0/20 (harness `bun-apps/scripts/recall-audit.mjs`).
- **SurrealDB seam exists — in hermes only**: `bun-apps/s2-agent-ext-hermes-memory/src/store/surreal/` (1746 lines; dependency-free HTTP client for v3 `/sql`, per-user-db namespacing `user_<id>`/`memory`, contract tests proving sqlite↔surreal equivalence). Local SurrealDB service on `127.0.0.1:8000`.
- **OpenViking reference**: local `/Users/huangziyu/proj/OpenViking` (upstream `github.com/volcengine/OpenViking`, AGPLv3 — capability reference only, no code port; it is Python+Rust). Its measured claims: L0/L1/L2 layering = 34–91% input-token reduction; LoCoMo 80–83% vs 24–57% native. Core-5 determined by capability inventory (this session): virtual-FS read model, L0/L1/L2 layering, session extraction with LLM dedup-merge, hierarchical retrieval with score propagation (depends on the index carrying `parent_uri` + per-directory embeddings), hotness decay (`sigmoid(log1p(active_count)) * exp_decay(half_life 7d)` — ~60 lines).
- **Constraining decisions already made elsewhere** (cited, not re-decided): context-lifecycle D0 (breaking scope open in kcard), D3 (bge-m3 canonical via `embedding-leaf.ts`, re-confirmed 2026-08-23), D5/D6 (deterministic-first retrieval: no LLM intent analysis, no rerank in v1), D7 (md-git-canonical; OpenViking sidecar files already charted-and-rejected), D8 (feedback re-ranks bounded ≤±10%, must beat count baseline before default). knowledge-pipeline D04 (SurrealDB HNSW as primary vector store), D05 (3-tier md↔DB drift classification).
- **SurrealDB v3 measured (ticket 03, live probe 2026-08-23, `surrealdb-3.2.3`)**: HNSW works at 1024-dim COSINE (~886 rows/s bulk insert, p50 28 ms KNN warm); MTREE absent; KNN syntax `<|k,ef|>` only; directory recursion must be client-side per-level BFS (~40–50 ms/level; nested SurrealQL times out at depth 2); snowball FTS is AND-only per query; index rebuild is NOT reader-transparent (transient empties) → shadow-db swap or T5 fallback during regen; `/sql` body cap 1 MiB.

## Tickets

### Phase A — foundation seams

- [ ] 01 — SurrealDB client ownership: extract hermes `surreal-client.ts` vs import vs copy (grilling)
- [ ] 02 — SurrealDB index schema for kcard: cards + directory/agg nodes as record links, embeddings, relations, hotness counters (grilling, blocked by 01)
- [x] 03 — SurrealDB v3 vector/FTS capability probe (CLOSED 2026-08-23 — HNSW 1024-dim COSINE PASS, MTREE absent, KNN = `<|k,ef|>` only, recursion must be client-side BFS, FTS AND-only, rebuild not reader-transparent; detail in ticket)

### Phase B — capability build-out

- [ ] 04 — typed memory model: map OpenViking memory types (profile/entities/events/cases/…) onto kcard card kinds + schema registry (grilling, blocked by 02)
- [ ] 05 — FS-style read surface: `ls/tree/find/grep` semantics over vault + tier ladder; relation to existing tool surface (prototype, blocked by 02)
- [ ] 06 — session commit → extraction loop: hermes journal → dedup-merge → cards; LLM dedup decisions skip/create/merge/delete; relation to existing distill converge (grilling, blocked by 04)
- [ ] 07 — hierarchical retrieval: directory-recursive search with score propagation on SurrealDB; deterministic per D5/D6 (no LLM intent analyzer — decision fork inside) (grilling, blocked by 02, 03)
- [ ] 08 — hotness decay port: sigmoid+exp formula, bounded ≤±10% per D8, RecallLedger as usage feed (grilling, blocked by 07)

### Phase C — gate & handoff

- [ ] 09 — evaluation gate: extend recall-audit to measure hierarchical retrieval vs 17/20 baseline; regression gate before any default switch (grilling, blocked by 07)
- [ ] 10 — collapse to spec: hand off to `to-spec` → `to-tickets` for the build plan (task, blocked by 04–09)

## Decisions

- **D1 — scope = OpenViking Core-5, nothing more.** Typed memory model, FS-style read surface, session-commit→memory extraction, hierarchical retrieval, bounded hotness. VikingBot, Web Studio, encryption, privacy configs, multi-tenancy, ovpack, watch management, cloud rerank/intent/VLM are out of scope — peripheral to this stack (s2-agent already is the agent framework; single-user local deployment). Reason: the capability inventory's 20/80 judgment; also honors the no-cloud rule and D5/D6.
- **D2 — SurrealDB is a derived, rebuildable index; vault md stays sole canonical.** Everything in SurrealDB (embeddings, hierarchy links, relations, hotness counters) regenerates from md; gitignored, hash-gated regen — same pattern as the existing model-keyed semantic JSON cache. Reason: consistent with D7 (md-git-canonical, sidecars already rejected) and knowledge-pipeline D05 tier classification; zero migration risk for 1925 cards.
- **D3 — Builds-on context-lifecycle; efforts stay independent.** This effort cites context-lifecycle D0/D3/D5/D6/D8 rather than re-deciding; its open tickets 08–17 stay there (ticket 08's auto-recall injector is the downstream consumer of this effort's retrieval surface, via the `__piKnowledgePipeline` seam). Back-link added to both maps.

## Frontier

Ticket 01 (SurrealDB client ownership) — the only open unblocked ticket now that ticket 03 closed; it is HITL grilling and everything in Phase B lands on the seam it decides. Ticket 03's probe facts (schemaless vec field, `<|k,ef|>`, client-side BFS, shadow rebuild) feed directly into its discussion.

## Fog of war

- Rebuild/backfill strategy for 1925 cards + embeddings at index first-build (kp04 background-backfill-queue precedent may apply).
- Per-user namespacing: does kcard's index adopt hermes's `user_<id>` scheme, or one shared namespace?
- Tool-surface impact: does the FS read surface absorb/reshape `zk_ask`/`knowledge_query` (tool-gating contract + hermes seam consumers must be consulted)?
- hermes backend-default ambiguity (leanrag-simplify D1 says SurrealDB default; `backend-factory.ts` defaults sqlite) — flag when ticket 01 touches that file.
- Whether OpenViking's intent-analysis-free constraint (D5/D6) survives contact with multi-type memory (typed queries in OpenViking come from the intent analyzer) — decide inside ticket 07.
- Scale trigger from knowledge-pipeline D03 (>5k rels / >2k cards — already at 1925 cards) may force relation-index decisions earlier.

## Cross-effort links

- `Builds-on: 2026-08-22-context-lifecycle` — D0 breaking scope, D3 embed canonical, D5/D6 deterministic retrieval, D8 bounded feedback; its ticket 08 auto-recall consumes our retrieval surface.
- `Builds-on: 2026-08-08-knowledge-pipeline` — D04 chose SurrealDB as the vector store; D05 tier classification is what D2 here instantiates for kcard.
- `Shares-decision-with: 2026-08-16-hermes-leanrag-simplify` — D1 SurrealDB-vs-sqlite default tension resurfaces in ticket 01's client-ownership discussion.
