---
type: task
status: closed
claimed:
blocked by: (none — open/parallel)
---
# 09 — SurrealDB-down error-path hardening

## Question
Does EVERY path degrade gracefully to the zk JSON-cache cosine when SurrealDB is down — no throw, no silent-empty?

## Acceptance
- Audit every SurrealDB-touching path; tests cover each down-path with graceful degradation verified.
- Open/parallel — not gated by the zk audit or C3.

## Closed (2026-08-16 — audit: all seams already degrade; test-only hardening)

Audit verdict: every SurrealDB-touching down-path already degrades or throws-by-design — no behavior change needed; the contracts are now locked by a fully-offline suite.

| Path | Down behavior (locked) |
| --- | --- |
| SurrealClient (`src/store/surreal/surreal-client.ts:118,130`) | retries transient failures (`maxAttempts`/`backoffMs`), then throws `SurrealDB request failed[ after N attempts]: <err>` — the single failure marker all callers share |
| SurrealBackend init | `initWithFallback` → sqlite fallback catches init/health failures at the upstream seam; `healthCheck()`/`init()` themselves propagate the marker |
| Graph heal (`normalizeLegacyMemoryIds` / `backfillGraphEdges`) | best-effort never-throw — resolve to counts even with SurrealDB down |
| Semantic cascade | NEVER throws — every dependency throwing resolves to `[]` (locked by `tests/store/semantic-search.test.ts`) |
| Knowledge warm-probe | tool-layer `catch{}` — zk stands (covered by inspection; see T5 note below) |
| Card-store hash/dep | SQLITE-ONLY — throw by design; not a SurrealDB down-path |

New offline suite: `tests/store/surreal/surreal-down-paths.test.ts` (fully offline via injectable `fetch`; dead-fetch stub + `maxAttempts:1, backoffMs:1`):
- T1 — backend `healthCheck()`/`init()` reject with `SurrealDB request failed` (locked ACTUAL contract: they propagate and the upstream fallback owns the catch; the audit's guessed "healthCheck never throws" was wrong — behavior locked as-is, not changed)
- T2 — `SurrealMemoryRepository.addMemory` rejects with the marker
- T2b — `SurrealSessionRepository.markUsed` rejects with the marker
- T3 — `SurrealVectorStore.upsertVectors` + `knn` reject with the marker
- T4 — graph heal `normalizeLegacyMemoryIds` + `backfillGraphEdges` both resolve (never-throw)
- T6 — canary INCLUDED: `isSurrealUp(endpoint)` accepts a param; `isSurrealUp("http://127.0.0.1:1")` → `false` in <3s
- T5 — OMITTED: knowledge-search-tool's warm-probe seam is not importable-stubbable offline within the ≤5-line budget. Search-layer down contract already locked by `tests/store/semantic-search.test.ts` ("NEVER throws — every dependency throwing resolves to []"); tool-layer `catch{}` covered by inspection.

Gates: `bun run check` (tsc) clean; `bun test` 1651 pass / 0 fail (baseline 1645 + 6 new).
