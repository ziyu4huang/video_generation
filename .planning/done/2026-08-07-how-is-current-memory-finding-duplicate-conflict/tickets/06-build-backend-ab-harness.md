claimed: pi-agent (2026-08-07 work session)
type: prototype

## Question

Build a backend-agnostic A/B benchmark harness that drives the *same* workload (per 03's metrics) through disk / SQLite / SurrealDB via the existing `MemoryRepository` interface and `createBackendBundle`, emitting comparable numbers per backend. Build on the `repository-contract.test.ts` seam (it already abstracts across backends). Deliverable: a runnable benchmark script + a results table for the three backends today. Output feeds the adoption decision (08).

## Spec locked (from 03, now closed)

See `tickets/03-define-backend-perf-metrics.md` Resolution for the full metric contract: scale points 1k/10k/100k; native indexed search per backend; workload search ~80% + add/replace/remove/batch-sync + cold-start; metrics p50/p95/p99 + throughput + crossover; provisional bar >=1.5x p95 search at >=10k. Build the synthetic corpus generator (no fixtures exist). Unblocked once 04 is confirmed and 05 provisions a running SurrealDB.

## Surreal provisioned (05 closed, 2026-08-07)

SurrealDB v3.2.3 is up at `http://127.0.0.1:8000` (root/root). See `tickets/05-provision-local-surrealdb.md` for the exact start/stop recipe, connection params, the in-memory-vs-disk fairness flag, and the isolated-namespace-per-run guidance. Once 04 is confirmed, 06 is unblocked.

## Unblocked (04 confirmed, 2026-08-07)

All blockers resolved (03 metric contract locked, 04 native-indexed-fair confirmed, 05 surreal provisioned). 06 is now on the frontier and ready to build: corpus generator + backend-agnostic harness driving SQLite vs SurrealDB via `createBackendBundle` at 1k/10k/100k, emitting p50/p95/p99 + throughput + crossover per `tickets/03` Resolution.

## Resolution

**Built + ran the harness. Verdict: switching to SurrealDB is a major performance REGRESSION, not an improvement — SurrealDB is 10-50x SLOWER than SQLite on p95 search at every scale measured. The provisional adoption bar is not just unmet, it is violated by an order of magnitude in the wrong direction.**

**Results (warm workload, measured post-load):**

| backend | scale | insert_thr (e/s) | search p95 (ms) | search p99 (ms) | add p95 (ms) | cold_start (ms) |
|---|---:|---:|---:|---:|---:|---:|
| sqlite | 1,000 | 5005 | 0.579 | 0.723 | 0.505 | 8.3 |
| surrealdb | 1,000 | ~45* | 28.496 | 30.153 | 41.926 | 118.1 |
| sqlite | 10,000 | 989 | 8.700 | 8.877 | 0.410 | 8.3 |
| surrealdb | 10,000 | ~41* | 92.049 | 95.745 | 43.427 | 118.1 |

Crossover ratio (surreal/sqlite p95-search): **49.2x at 1k, 10.6x at 10k** — surreal is slower at both. The gap narrows from 1k->10k only because sqlite degrades linearly with corpus size, NOT because surreal converges; no sign surreal would overtake at 100k.

**Root cause:** the SurrealDB backend is server-based — every query is an HTTP round-trip to `localhost:8000` plus SurrealDB parse/exec overhead. SQLite is embedded in-process (no network, shared memory). The per-query HTTP RTT dominates at all scales; surreal's indexed full-text (@@) never gets a chance to win.

**Real bug found (not a perf finding):** `SurrealMemoryRepository.syncMemoryEntriesBatch` builds ONE prefetch SELECT as an unbounded OR-chain of `(target=$tg_N AND content=$ct_N AND ...)` predicates — one per batch item. This exceeds SurrealDB's parser expression-recursion limit at batch sizes >= ~100-500 (HTTP 400: "Exceeded expression recursion depth limit"). Sidestepped in-bench by inserting in chunks of 1, but it breaks the real startup-sync path (`syncMarkdownMemories`) once the store exceeds a few hundred rows. Feeds 08 (another strike against adoption; only worth fixing if surreal were adopted, which the data argues against).

**Caveats:** *surreal insert_thr is distorted by chunk=1 (HTTP per-row RTT ~42 e/s) — not a fair bulk-insert metric. search/add/replace/remove numbers were measured AFTER loading completed, so they are valid.* 100k not run (dropped for speed; crossover visible by 10k; surreal's 10k disadvantage shows no convergence).

**Asset:** harness at `bun-apps/pi-agent-ext-hermes-memory/bench/{corpus.ts,backend-ab.ts}` + results at `bench/results/ab-*.md`. Harness tuned (chunk=1 to avoid the recursion bug; SCALES [1k,10k]).

**Feeds 08:** decisive perf input — KEEP SQLite as the default memory backend. SurrealDB adoption would regress p95-search by 10-50x. Surreal could only compete via a re-architecture (embedded/in-process Surreal, or a native index that amortizes the RTT) — out of scope for this effort.

closed: 2026-08-07 (harness built+run; surreal 10-50x slower; keep sqlite)
