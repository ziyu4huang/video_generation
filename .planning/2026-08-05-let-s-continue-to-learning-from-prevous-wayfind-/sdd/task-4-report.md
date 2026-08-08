# Task 4 — Deterministic failure-backlog canonicalization (v1)

**Branch:** `build/failure-model-v1`
**Commit:** `31269c09af7db43bc385fb355544c1001231f1f9`
**Status:** DONE

Creates a NEW pure module `src/failure-model-migration.ts` — the one-time
deterministic canonicalization of the failure backlog. Mirrors
`src/project-memory-migration.ts`'s pattern (pure fs read/write + result
struct, **no LLM**) so the before/after diff is fully auditable. Three tiers
applied in order: (1) near-dup wording collapse (longest-wins),
(2) topic-family collapse (most-recent last-date wins; ties → longest),
(3) compress resolved/stale survivors to a one-line canonical fact. Active
unique entries are never touched.

## Files created

- `bun-apps/pi-agent-ext-hermes-memory/src/failure-model-migration.ts` (verbatim per spec)
- `bun-apps/pi-agent-ext-hermes-memory/src/failure-model-migration.test.ts` (verbatim per spec, "active unique" fixture)

## Imported dependencies (all verified real exports)

- `ENTRY_DELIMITER` — `./constants.js`
- `parseMarkdownMemoryEntry`, `serializeMetadataComment`, `today` — `./store/memory-format.js`
- `findNearDuplicate`, `DEFAULT_NEAR_DUP_THRESHOLD` — `./store/near-dup.js`
- `topicKey` — `./store/topic-key.js` (Task 2)

## TDD red → green

1. Wrote `failure-model-migration.test.ts` first.
2. RED — `bun test src/failure-model-migration.test.ts` → `0 pass, 1 fail`
   (`Cannot find module './failure-model-migration.js'`).
3. Created `failure-model-migration.ts` verbatim.
4. GREEN — `bun test src/failure-model-migration.test.ts` → **3 pass, 0 fail** (10 expect calls).

## Full-suite regression

`bun test` (whole package) → **1251 pass, 1 skip, 0 fail** (1042 expect calls,
99 files, 13.30s). The 1 skip is a pre-existing schema test (`md_id is unique
among non-NULL values`); no new failures introduced.

## Migration result for the main fixture

Fixture: 5 entries — `a`/`b` identical `await_pr_merge` wording, `c` same topic
(`await_pr_merge`) different wording, `d` resolved `await_pr_merge` post-#1030,
`e` unrelated unique `insight` about mlx bfloat16.

| metric          | value |
|-----------------|-------|
| scanned         | 5     |
| nearDupCollapsed| 1     | (a/b identical wording collapse, Tier 1)
| topicCollapsed  | 2     | (c→family + d join under `await_pr_merge` topic-key, Tier 2)
| compressed      | 1     | (resolved survivor → one-line canonical fact, Tier 3)
| dropped         | 3     | (nearDupCollapsed + topicCollapsed total)
| finalChars      | 264   | (down from 661; ~60% reduction)
| **survivors**   | **2** | (d compressed canonical fact + e unique insight)

Tier-2 winner = `d` (most-recent `last=2026-08-04`), which Tier-3 then
compresses to:
`[tool-quirk] await_pr_merge now merges directly once CI green (post #1030) (resolved/compressed) <!-- ... -->`

This confirms the spec's intent: collapse the noisy `await_pr_merge` family to a
single resolved canonical fact, preserve the unrelated `insight` entry verbatim.

## Deviation

None. Implementation and tests were written verbatim per spec; no test
expectation needed changing. (A throwaway `mig-probe.ts` was used to capture the
fixture numbers for this report and deleted immediately; it was never committed.)
