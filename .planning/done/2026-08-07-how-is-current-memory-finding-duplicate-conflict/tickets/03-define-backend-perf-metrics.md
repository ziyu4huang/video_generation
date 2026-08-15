claimed: pi-agent (2026-08-07 work session)
type: grilling

## Question

What defines "performance improved" for the backend A/B? Pin metrics + workload: per-op latency (add / search / replace / remove / batch-sync), with **search weighted as the hot path** (every `memory_search`); throughput (ops/sec); scale curve (e.g. 1k / 10k / 100k entries); cold-start vs warm; corpus size grounded in the real `.md` store today. Decide what numbers the harness must emit and what difference counts as "improved." Gates ticket 06.

## Resolution

**A/B purpose = stress-scale crossover curve.** Current scale (69 entries, ~57KB) has ~0 perf to gain — both backends are already O(log n) indexed full-text and sub-ms. The harness therefore characterizes the *scale curve* and finds the crossover point where SurrealDB pulls ahead of SQLite, rather than chasing a current-scale win. Note: current default backend is SQLite (`src/config.ts:105`), not disk; "switch to surrealdb" means SQLite->SurrealDB for the search/sync index, with disk MD staying canonical either way.

**Metric contract for the harness (feeds ticket 06):**
- **Scale points**: synthetic 1k / 10k / 100k entries. No fixtures exist -> build a generator emitting realistic ~500-2000-char entries, term distribution modeled on the real 69-entry store.
- **Backends**: SQLite (default) vs SurrealDB, each via its **native indexed search** — both are already apples-to-apples indexed full-text (SQLite FTS5 MATCH at `sqlite-memory-repo.ts:431`; SurrealDB `@@` at `surreal-memory-repo.ts:698`). This substantially answers ticket 04.
- **Workload per scale point**: search weighted heaviest (~80% — the hot path) + add / replace / remove / batch-sync + **cold-start** (fresh backend init + first query).
- **Metrics per op**: latency **p50 / p95 / p99** + throughput (ops/sec) + the **crossover point** (scale where SurrealDB p95 search < SQLite p95 search, if any). p99 is mandatory: SurrealDB is a separate server (network round-trip + its own GC) vs SQLite in-process — the tail is exactly where SQLite may win even if SurrealDB wins p50 at scale.
- **Improvement signal (provisional; 08 applies final ops-cost judgment)**: harness reports crossover + magnitude per scale; provisional flag = >=1.5x lower p95 search at >=10k entries -> "SurrealDB worth adopting." No hard bar locked here.
- **Reuse**: extend `src/perf.ts` (`timed`/`timedAlways`, which does NOT yet instrument search); build the corpus generator from scratch; drive backends via `createBackendBundle` on the `repository-contract.test.ts` seam.

**De-fogs:** ticket 04 (search-semantics fairness) — both backends native indexed full-text, fair as-is, ready for a one-line confirm. Ticket 06 (harness) — 03 satisfied; real remaining blockers are 04 (confirm) and 05 (provision SurrealDB) + a running instance to benchmark.

closed: 2026-08-07 (grilling resolved: stress-scale crossover, p50/p95/p99, provisional bar)
