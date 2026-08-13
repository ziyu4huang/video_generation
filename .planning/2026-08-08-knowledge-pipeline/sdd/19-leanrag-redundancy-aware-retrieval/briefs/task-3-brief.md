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
