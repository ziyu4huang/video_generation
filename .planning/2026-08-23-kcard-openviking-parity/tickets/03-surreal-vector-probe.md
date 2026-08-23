# 03 — SurrealDB v3 vector/FTS capability probe

type: research
claimed: charting-session (research subagent, 2026-08-23)
blocked by: (none)

## Question

Does the local SurrealDB v3 service (127.0.0.1:8000) actually support what ticket 02/07 assume? Probe live (read hermes's client + contract tests for invocation patterns; create scratch tables in a scratch namespace, not `user_huangziyu`):

- Vector indexes: `DEFINE INDEX ... MTREE` / `HNSW` availability and limits in v3; does HNSW work at **1024 dimensions** (bge-m3)? Distance metric support (cosine)? `<|KNN|>` operator behavior.
- Whether per-directory embeddings (agg nodes) can share the index with leaf cards.
- Fulltext: `snowball(english)` analyzer (hermes already uses it) — tokenizes card summaries well enough for the deterministic lexical lane?
- Record-link traversal cost for the directory recursion (depth ≤ 4 layers, 326 agg nodes).
- Failure modes: what happens on index rebuild while queries run (the "index derived, md canonical" invariant must survive concurrent access).

## Resolution (2026-08-23, live probe — CLOSED)

Server: `surrealdb-3.2.3+20260721.40522d1` at `http://127.0.0.1:8000`. All probes executed live against scratch ns `probe` / db `kcard_probe` (removed + verified after). Prior art reused: hermes `bench/hnsw-vs-cosine.ts` (768-dim, ticket 16).

**Verdicts:**

| Probe | Verdict |
|---|---|
| P1 HNSW @1024-dim COSINE | **PASS** — `DEFINE INDEX … FIELDS vec HNSW DIMENSION 1024 DIST COSINE TYPE F32`. Schemafull vector field types (`F32[1024]`, `vector<F32,1024>`) are PARSE ERRORS on 3.2.3 → table must be SCHEMALESS for the vec field. |
| P2 MTREE | **ABSENT** — keyword does not parse on 3.2.3. HNSW is the only vector index (bench: HNSW wins ≥10–30k rows; brute-force cosine = 188 ms @2004 rows). |
| P3 bulk INSERT | **PASS** — 2000 mixed rows w/ vectors ≈ 886 rows/s incl. incremental HNSW build. `/sql` body cap **1 MiB (HTTP 413)** → ≤ ~100×1024-dim CREATEs/request; one PARSE error 400s the whole batch. |
| P4 KNN | **PASS** — only the 2-arg form `<|10,100|> $q` parses (`<|KNN|>`/`<KNN>` are errors). Cold-start 3326 ms, then p50 28 ms / p95 29 ms. Combo filter `is_leaf = true AND vec <|5,100|> $q` works. |
| P5 mixed table + traversal | **PASS w/ trap** — one schemaless table holds leaf+agg rows under one HNSW index; multi-hop dereference works (24–25 ms). **Nested IN-subqueries unusable** (depth-2 times out at 60 s) → recursion must be **client-side per-level BFS** (`WHERE parent IN $ids`, ~40–50 ms/level; full 4-deep walk 170 ms). TRAP: `parent IN $ids` matches ONLY record-id literals — JSON-string arrays silently match nothing (use bare literals or `type::record($s)`). |
| P6 snowball FTS | **PASS w/ caveats** — operator is `@0@` (index ordinal; `MATCH` keyword is a parse error). Stemming verified (`retries`/`retrying`/`retried` → same rows). **Multi-word = implicit AND, no union operator** → lexical lane must issue per-term queries and merge client-side. `search::score(0)` ranks correctly. |
| P7 rebuild under load | **CAVEAT** — DELETE-all + re-INSERT while KNN loops: 1/97 queries hit 30 s timeout, 2 returned EMPTY mid-rebuild. A rebuild is NOT transparent to readers → regen into a fresh db + swap, or gate reads behind the T5 JSON-cosine fallback during rebuild windows. |

**Carried into tickets 02/07:** schemaless vec field (enforce shape in TS); `<|k,ef|>` KNN standard (EF=100 proven); client-side BFS recursion with record-literal LET params; shadow-db rebuild; 1-MiB-capped backfill batcher (~2250 vectors ≈ 2.5 s full insert — well inside budget); per-term FTS merged client-side.

Full probe transcript (SurrealQL per claim) available from the research session, 2026-08-23.
