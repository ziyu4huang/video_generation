# Plan — ticket 19: LeanRAG redundancy-aware retrieval (dedup-first slice)

- **Ticket:** `tickets/19-leanrag-redundancy-aware-retrieval.md`
- **ADR:** `bun-apps/pi-agent-ext-hermes-memory/docs/adr/0001-leanrag-selective-port.md`
- **Scope (re-scoped 2026-08-13):** exact-contentHash dedup + re-rank seam + survivingK knob inside `searchSemantic` (warm + cold). The multi-signal frequency-vote is ticket 20.

## Context

`searchSemantic` (`bun-apps/pi-agent-ext-hermes-memory/src/store/semantic-search.ts`) is the semantic-search spine: warm path = embed → `VectorStore.knn` (HNSW) → ranked `SemanticSearchHit[]`; cold path = `knowledgeFallback` (zk cosine) / `memoryFallback` (lexical FTS), ticket 14 T5a. It NEVER throws. Today it dedups by `mdId` only; it does NOT dedup by content, and `contentHash` is not on any result object.

The knn SELECT (`vector-store.ts`) currently omits `contentHash` even though the `card_vectors` row stores it.

Config knobs follow a strict 4-point pattern (constants.ts default → types.ts `MemoryConfig` field → config.ts `DEFAULT_CONFIG` → config.ts `loadConfig` allowlist) — see ticket 14's `vectorTopK`/`vectorEf`.

## Global Constraints

- **Never throws.** `searchSemantic`'s T5a invariant (ticket 14) is absolute: dedup + survivingK must never cause a throw; any failure path returns the best-available list or `[]`.
- **contentHash is optional on hits.** Warm-path hits carry it (from knn); cold-path hits may not (memory `MemoryEntry` has no contentHash column). Dedup must treat a missing contentHash as "not collapsible" (keep the hit), never as a key that groups all hashless hits together.
- **Single seam.** Dedup lives inside `searchSemantic` (a shared private helper applied to each path's output), not at callers. (`knowledge-search-tool.ts` has its own `kp.retrieveRecords` retrieve that is NOT routed through `searchSemantic` — changing that is out of scope; only `searchSemantic`'s own results are deduped.)
- **Config = 4 points.** `survivingK` must be registered in all four locations; `searchSemantic` reads it via a new `SearchSemanticOptions.survivingK?` (callers pass `config.survivingK`), NOT by importing config directly.
- **No boostWeight.** The multi-signal `boostWeight` knob is ticket 20's concern; do not add it here (YAGNI — one signal today).
- **Test style:** `bun:test` `describe/it/expect/mock`, injectable mock factories, `toEqual<...>` exact-shape asserts — match `tests/store/semantic-search.test.ts`.

## Task 1 — Surface contentHash on the warm path

Augment the HNSW knn path to return `contentHash` and thread it into `SemanticSearchHit`.

- `src/store/surreal/vector-store.ts`: change the `knn` SELECT to `SELECT mdId, kind, contentHash FROM card_vectors WHERE vec <|${k},${ef}|> $q`; extend `VectorKnnHit` with `contentHash?: string`; map it through.
- `src/store/semantic-search.ts`: add `contentHash?: string` to `SemanticSearchHit`; populate it in `toHit`.
- TDD (red-green) in `tests/store/semantic-search.test.ts`: a warm-path test asserting the returned `SemanticSearchHit` carries the `contentHash` from the fake vector store's knn result. (The fake `VectorKnnHit` must include `contentHash`.)

## Task 2 — Exact-contentHash dedup + re-rank seam (warm + cold)

Add a shared dedup helper and apply it on every return path.

- `src/store/semantic-search.ts`: add a private `dedupByContentHash(hits: SemanticSearchHit[]): SemanticSearchHit[]` — keeps the first occurrence per `contentHash`; hits with no `contentHash` are always kept (per Global Constraint). Apply it to the warm path's `ranked` list (before the early return) AND to the output of `knowledgeFallback` and `memoryFallback`.
- Preserve the existing `mdId`-dedup + exclude + kind-filter + topK logic; contentHash-dedup is an additional pass.
- TDD: (a) warm path — two knn hits with the same `contentHash` collapse to one; (b) cold path — duplicate-hash knowledge (or memory) hits collapse; (c) never-throws — dedup over a malformed/empty input returns `[]`/the input unchanged without throwing.

## Task 3 — survivingK config knob

Register `survivingK` (caps the returned list) across the 4 config points + thread it through.

- `src/constants.ts`: `export const DEFAULT_SURVIVING_K = 10;` (mirror `DEFAULT_VECTOR_TOP_K`).
- `src/types.ts`: add `survivingK: number;` to `MemoryConfig`.
- `src/config.ts`: add `survivingK: DEFAULT_SURVIVING_K,` to `DEFAULT_CONFIG`; add a `loadConfig` allowlist line mirroring `vectorTopK`'s `>0 floor` guard.
- `src/store/semantic-search.ts`: add `survivingK?: number` to `SearchSemanticOptions`; cap the final returned list to `survivingK` (default `topK`) on every path.
- TDD: (a) config parses a valid `survivingK`; (b) invalid values (≤0, NaN, non-number) are rejected (default kept); (c) `searchSemantic` caps the result to `survivingK`.

## Out of scope

- Multi-signal frequency-vote + `boostWeight` → ticket 20.
- Deduping `knowledge-search-tool.ts`'s own `kp.retrieveRecords` results → future (the tool's separate retrieve).
- Entity recall, relation-dedup, ⑥ → ticket 03. Near-dup cosine → ticket 17.
