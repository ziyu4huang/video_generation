# Task 1 — `failureModel` config flag (legacy|v1)

**Branch:** `build/failure-model-v1`
**Commit:** `9ad40ffe5950a41a0eb8e8652dc7dd5241368406`
**Status:** DONE

Adds the `failureModel` feature-flag field across the hermes-memory config
surface (the "drift trap" — 4 spots — so later tasks can read
`this.config.failureModel` reliably).

## Changes per spot

### Spot 1 — `src/types.ts`
- Added `export type FailureModel = "legacy" | "v1";` with the spec's full
  JSDoc block, placed immediately before `interface MemoryConfig` (right after
  `SessionSearchConfig`) — i.e. adjacent to the `memoryMode` block it mirrors.
- Added `failureModel?: FailureModel;` field inside `MemoryConfig` directly
  under `memoryMode` (default `"legacy"`).

### Spot 2 — `src/constants.ts`
- Added `export const DEFAULT_FAILURE_MODEL = "legacy" as const;` with the
  spec's JSDoc, immediately after `DEFAULT_FAILURE_CHAR_LIMIT`.

### Spot 3+4 — `src/config.ts` (3 edits)
- **(a) import:** added `DEFAULT_FAILURE_MODEL,` to the `"./constants.js"`
  import block (after `DEFAULT_PROACTIVE_COOLDOWN_MINUTES,`).
- **(b) DEFAULT_CONFIG:** added `failureModel: DEFAULT_FAILURE_MODEL,` after
  `dbBackend: "sqlite",`.
- **(c) allowlist:** added
  `if (parsed.failureModel === "legacy" || parsed.failureModel === "v1") config.failureModel = parsed.failureModel;`
  directly after the existing `memoryMode` allowlist line, mirroring its shape.

### Test — `tests/config.test.ts`
Appended the spec's test at the end of the file. **Deviation (minimal,
faithful):** the spec snippet used vitest-style `test(...)` + `expect(...).toBe()`,
but this file uses the `bun:test` idiom exclusively — it imports
`{ describe, it, beforeEach, afterEach }` from `"bun:test"` and `assert` from
`"node:assert"`, and `test`/`expect` are NOT available as globals (confirmed:
`ReferenceError: test is not defined`). The file's `os`, `fs`, `path`, and
`loadConfig` imports were already present (no import additions needed). I
converted the snippet to the file's idiom — `it(...)` + `assert.strictEqual(...)`
— preserving the three assertions and their exact expected values
(`"legacy"` default / `"v1"` read / `"bogus"`→`"legacy"` ignore) verbatim.

## TDD sequence + results

1. **Appended test first** → `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/config.test.ts )`.
2. **Red:** `60 run → 59 pass / 1 fail` — the new test failed with
   `AssertionError: undefined !== 'legacy'` (failureModel field did not yet
   exist). Correct failure reason.
3. **Made the 4 source edits.**
4. **Green:** `60 run → 60 pass / 0 fail`.
5. **Full package suite:** `( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`
   → **`1241 run → 1240 pass / 1 skip / 0 fail`** (1017 expect calls, 97 files,
   13.31s). No regression. The single skip is pre-existing
   (`md_id schema > SQLite: md_id is unique among non-NULL values`).

## Commit

Message: `feat(memory): add failureModel config flag (legacy|v1)`
Paths committed (explicit `git add`, no `-A`):
- `bun-apps/pi-agent-ext-hermes-memory/src/types.ts`
- `bun-apps/pi-agent-ext-hermes-memory/src/constants.ts`
- `bun-apps/pi-agent-ext-hermes-memory/src/config.ts`
- `bun-apps/pi-agent-ext-hermes-memory/tests/config.test.ts`

`git show --stat`: 4 files changed, 27 insertions(+). Working tree clean
after commit.

## Deviation summary

One adaptation (documented above): test snippet rewritten from vitest
`test()`/`expect().toBe()` to the file's existing `bun:test` `it()` +
`node:assert` `strictEqual` idiom. Assertion count, inputs, and expected
values are unchanged. No source-path or signature deviations from the spec.
