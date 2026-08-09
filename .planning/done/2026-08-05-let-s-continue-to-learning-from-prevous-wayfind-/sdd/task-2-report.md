# Task 2 Report — topic-key extraction + recurrence detector

**Branch:** `build/failure-model-v1`
**Commit:** `2d45081a` — `feat(memory): add topic-key extraction + recurrence detector`

## Files created
- `bun-apps/pi-agent-ext-hermes-memory/src/store/topic-key.ts` — implementation (verbatim from spec)
- `bun-apps/pi-agent-ext-hermes-memory/src/store/topic-key.test.ts` — unit tests (verbatim from spec)

Both files written verbatim per the task spec; no deviations from the prescribed source.

## Dependencies verified (pre-exist, unchanged)
- `src/types.ts` → `MemoryCategory` (6 values) — `KNOWN_CATEGORIES` matches exactly.
- `src/store/near-dup.ts` → `nearDupTokens` (Set-returning, positional).

## TDD results

**Step 2 — RED** (test written first, impl absent):
```
( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/topic-key.test.ts )
error: Cannot find module './topic-key.js'
 0 pass | 1 fail | 1 error
```

**Step 4 — GREEN** (impl created):
```
( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/topic-key.test.ts )
 8 pass | 0 fail | 15 expect() calls | 1 file
```

## Flagged token expectations (both confirmed correct, no impl changes needed)
- **`surrealdb_snowball_tokenizer`** — `nearDupTokens("[insight] SurrealDB snowball tokenizer ignores short terms")` yields the ordered set `{surrealdb, snowball, tokenizer, ignores, short, terms}` (all ≥4 chars, none stopword/number); `slice(0,3).join("_")` = `surrealdb_snowball_tokenizer`. ✓
- **`gh_pr`** — fallback regex `/\b([a-z][a-z0-9_]+(?:[\s-][a-z][a-z0-9_-]+)?)\b/i` on "gh pr checks 1042 hangs on pending" captures `gh pr`; `normalizeKey` → `gh_pr`. ✓

No implementation bug found; spec and impl agree.

## Full package suite (regression check)
```
( cd bun-apps/pi-agent-ext-hermes-memory && bun test )
 1248 pass | 1 skip | 0 fail | 1032 expect() calls | 98 files | 13.35s
```
No regression.

## Concerns / deviations
None. Task is a pure leaf module (no store wiring) — Task 3 (write-gate) and Task 4 (migration) are unblocked to consume `topicKey` / `findTopicRecurrence` / `formatTopicRecurrenceWarning`.
