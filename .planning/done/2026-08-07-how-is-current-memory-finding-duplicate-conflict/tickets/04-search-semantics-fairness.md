type: grilling

## Question

For a fair A/B, do we run the *same* search logic against every backend, or each backend's *native* search (SQLite FTS5 / SurrealDB search / MD near-dup)? This decides whether the benchmark measures "identical algorithm, different storage" vs "each backend's best search," and it changes what "switch to SurrealDB" means for result *quality*, not just speed. Gates ticket 06; feeds the adoption decision (08).

## Preliminary finding (from 03's grounding research, 2026-08-07)

Largely answered: both backends already use indexed full-text search — SQLite FTS5 `MATCH` (`sqlite-memory-repo.ts:431`), SurrealDB `@@` fulltext (`surreal-memory-repo.ts:698`) — with similar fallback semantics (OR rewrite / `string::contains`). So a **native-search A/B is fair and apples-to-apples**; no need to force identical search logic across backends. Ready for a one-line confirm to close next session.

## Resolution

**Confirmed: native indexed search on both backends; the A/B is fair and apples-to-apples.** No need to force identical search logic across backends — each backend's own indexed full-text path IS the fair comparison.

- SQLite: FTS5 `MATCH` via external-content table `memory_fts` (`src/store/sqlite/sqlite-memory-repo.ts:431`), with OR-rewrite fallback.
- SurrealDB: `@@` fulltext via `DEFINE INDEX ... FULLTEXT ANALYZER hermes_en` (`src/store/surreal/surreal-memory-repo.ts:698`; schema `src/store/surreal/schema.ts:20`), with `string::contains` fallback.

Both are inverted-index full-text search with comparable fallback semantics, so measuring each backend's native search benchmarks "that backend's best search" honestly — which is exactly what an adoption decision wants (you ship whatever search the chosen backend provides). De-risks ticket 06 (no need to unify search logic) and feeds 08 (result-quality parity assumed; perf differs by backend, not algorithm).

closed: 2026-08-07 (confirmed native indexed both -> fair; de-risks 06)
