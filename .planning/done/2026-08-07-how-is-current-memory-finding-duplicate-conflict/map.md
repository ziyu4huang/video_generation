---
status: complete
effort: 2026-08-07-how-is-current-memory-finding-duplicate-conflict
created: 2026-08-07
---

## Destination

A measured decision on the default memory backend (disk-`MEMORY.md` / SQLite / SurrealDB) grounded in a backend-agnostic A/B performance harness, **and** a hardened duplicate/conflict-detection layer whose quality is provable against a labeled golden set. The end is reached when we (a) know which backend ships by default and why, and (b) have made dedup/conflict measurably better — or have an explicit, evidence-backed decision to leave it as-is.

## Notes

- **Domain**: memory store at `bun-apps/pi-agent-ext-hermes-memory/`. Key files: `src/store/memory-store.ts` (disk/MD layer + dedup), `src/store/near-dup.ts` (token-containment near-dup), `src/store/topic-key.ts` (topic recurrence), `src/store/merge-plan.ts` (hash-anchored conflict/merge), `src/store/repository.ts` (abstraction: `MemoryRepository`/`SessionRepository`/`Backend`), `src/store/backend-factory.ts`, `src/store/swappable.ts` (live-swap proxy), `src/store/sqlite/`, `src/store/surreal/`.
- **Skills each session consults**: wayfinder (work-through-the-map). For benchmarking, Bun's `Bun.nanoseconds()`; for the backend-agnostic seam, `tests/store/repository-contract.test.ts` (`runMemoryRepositoryContract`).
- **Standing prefs**: written artifacts in English; never top-level `cd` (use `( cd ... && ... )`); run `bun test` inside `bun-apps/`.
- **Git-state caveat (charted aware)**: detached HEAD at `0333bd93`, 2 commits behind `origin/main` — both commits are `pi-agent-ext-core-task` (todo/goal state) and touch ZERO memory/dedup/conflict/store files, so this effort's facts are identical to origin/main. Tree dirty: modified `.agents/memory/MEMORY.md` + untracked `.planning/` dirs. Rebase deferred by user choice.
- **False premise resolved at chart time**: the loose idea's "abstract the storage layer + add SurrealDB (optional)" is already satisfied — `repository.ts` + `backend-factory.ts` + `swappable.ts` provide the abstraction, and a SurrealDB backend ships at `src/store/surreal/`. This map therefore targets *measurement + adoption + dedup hardening*, not building either.

## Decisions so far

<!-- one line per closed ticket; open tickets are files under tickets/ -->

- [01-dedup-conflict-cross-backend-consistency](tickets/01-dedup-conflict-cross-backend-consistency.md) — dedup is MD-layer-only; SQLite/Surreal do identity-only `sync*` dedup and blind `addMemory` (double-persist gap); MD stays canonical.
- [03-define-backend-perf-metrics](tickets/03-define-backend-perf-metrics.md) — A/B = stress-scale crossover curve (1k/10k/100k), p50/p95/p99 + cold-start + throughput, search ~80% of workload; provisional bar >=1.5x p95 search at >=10k; de-fogs 04 (both backends native indexed full-text).
- [05-provision-local-surrealdb](tickets/05-provision-local-surrealdb.md) — SurrealDB v3.2.3 running @127.0.0.1:8000 (root/root, ns user_huangziyu, db memory, in-memory); real-backend test ran green (init+healthCheck). Recipe captured; 06 now only blocked by 04-confirm.
- [04-search-semantics-fairness](tickets/04-search-semantics-fairness.md) — native indexed full-text on both backends (SQLite FTS5 MATCH, SurrealDB @@) = fair A/B; no need to unify search logic. Fully unblocks 06.
- [06-build-backend-ab-harness](tickets/06-build-backend-ab-harness.md) — built+ran harness; SurrealDB is 10-50x SLOWER than SQLite on p95-search (49x@1k, 10.6x@10k); provisional bar violated wrong-direction -> keep SQLite. Also found surreal `syncMemoryEntriesBatch` OR-chain parser-recursion bug (breaks startup-sync at scale).
- [02-define-dedup-quality-methodology](tickets/02-define-dedup-quality-methodology.md) — methodology: hybrid (real 69-entry seeds + synthetic perturbations) golden set; P/R/F1 per layer (exact/near-dup/topic) + near-dup threshold sweep 0.3-0.9 vs current 0.60; detection-quality scope only (integrity gap tracked separately). Unblocks 07.
- [07-build-golden-dedup-corpus](tickets/07-build-golden-dedup-corpus.md) — 80-pair golden corpus + baseline: near-dup @0.6 recall 54.5% (F1 0.706) but @0.3 -> R 95.5%/F1 0.977 with ZERO precision loss at every threshold; exact & topic 100% recall. Verdict: token-containment sufficient, 0.6 threshold too high (~0.3-0.4 recovers recall for free), no new algo needed. Unblocks 08.

## Not yet specified

- **What to change in dedup** — RESOLVED by 07's baseline: threshold tuning suffices (0.6 -> ~0.3-0.4 lifts near-dup recall 54.5% -> ~95% with no precision loss); no new algorithm (MinHash/embeddings) warranted. Now an execution item for the post-map writing-plans handoff, not a map ticket.
- **Where dedup logic lives if SurrealDB is adopted** — promoted into the shared `MemoryRepository` contract, or DB-native (unique constraints / graph dedup)? Depends on the adoption decision (08) + search semantics (04).
- **Canonical source-of-truth** — does the MD file stay canonical if the default backend switches, or does the DB become canonical and MD becomes export-only? Resolves as part of 08.
- **Embeddings** — enter scope only if the baseline proves token-containment insufficient; they'd touch the storage layer (vector storage). Out of scope until proven.

## Out of scope

- Rewriting the disk/MD store format, the `§` delimiter, or the YAML/front-matter entry schema — orthogonal to perf/dedup-quality.
- Re-enabling remote GitHub Actions CI / branch protection (repo keeps remote CI disabled by design).
- Non-memory stores' perf (session indexing, prompt provenance) — only memory ops are in this A/B.

## Cross-effort links

- **Absorbed-by:** [2026-08-08-pi-agent-ext-knowledge-card-obsidian-surealdb-or](../2026-08-08-pi-agent-ext-knowledge-card-obsidian-surealdb-or/map.md) — generalizes this memory effort into a card-agnostic knowledge pipeline. This effort's open ticket 08 is resolved there (01: dedup promoted into store contract; MD canonical stands; backend now pending the 2026-08-08 A/B). Findings 06 (SQLite perf win) and 07 (near-dup threshold 0.6 -> ~0.3-0.4) carry forward as locked context. Ticket 08 closed 2026-08-08 as superseded.
> Closed 2026-08-15: fog resolved by later work: dedup-into-contract = C6 (#1349); backend = kp Decision 04; canonical = kp 09; residual threshold-tuning (0.6→0.3-0.4) folded into hermes-arch ticket 04.
