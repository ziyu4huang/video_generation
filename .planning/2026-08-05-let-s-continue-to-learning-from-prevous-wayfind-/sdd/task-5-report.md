# Task 5 Report: pi-memory-bulk-dedup Skill

## Task
Create the `pi-memory-bulk-dedup` procedural skill (agent-facing doc) for the hermes-memory failure store bulk deduplication feature.

## Execution Summary

### File Created
- `bun-apps/pi-agent-ext-hermes-memory/skills/pi-memory-bulk-dedup/SKILL.md`

### Frontmatter Verification
```bash
$ head -5 bun-apps/pi-agent-ext-hermes-memory/skills/pi-memory-bulk-dedup/SKILL.md
---
name: pi-memory-bulk-dedup
description: Bulk-dedup the hermes-memory failure store — near-dup + topic-family collapse, resolved-compression, recurrence→skill graduation. Dry-run + backup + diff before any destructive apply.
---
```
✅ Frontmatter valid - contains required `name` and `description` fields.

### Import Path Verification
```bash
$ ( cd bun-apps/pi-agent-ext-hermes-memory && bun -e "import {canonicalizeFailureBacklog} from './src/failure-model-migration.ts'; console.log(typeof canonicalizeFailureBacklog);" )
function
```
✅ Import resolved cleanly - `canonicalizeFailureBacklog` is a function. No path adjustment needed.

### Full Package Test Suite
```
1251 pass, 1 skip, 0 fail
```
✅ All tests passed - doc-only addition caused no regressions.

### Commit
```
Commit hash: 36c3488f
Message: docs(memory): add pi-memory-bulk-dedup skill (topic-family + graduation)
Files: 1 changed, 60 insertions(+)
```

## Deviations
None - execution proceeded exactly as specified with no adjustments needed.

## Status
**DONE**

---

## Final-Fix Report (Task 5 Doc/Comment Accuracy Fixes)

### Context
Applied final-review findings from task label `zk-spawn` — all DOC/COMMENT accuracy fixes with NO logic changes.

### Edits Made

#### 1. SKILL.md — Step 2 (REJECTED.md citation)
**File:** `bun-apps/pi-agent-ext-hermes-memory/skills/pi-memory-bulk-dedup/SKILL.md`
**Before:**
```
2. **Review the diff.** Confirm no unique lesson is dropped (REJECTED.md:
   destructive consolidation must not silently drop a unique lesson). If a
   collapsed family is a recurring *procedure* (≥2 captures), that is the
   graduation signal — capture it as a skill candidate first
   (`.planning/knowledge/<name>.md`), then promote via writing-skills.
```
**After:**
```
2. **Review the diff.** Confirm no unique lesson is dropped (REJECTED.md's
   destructive-consolidation row: active/unique entries are never trimmed; the
   dry-run diff makes every drop auditable). If a collapsed family is a recurring
   *procedure* (≥2 captures), that is the graduation signal — capture it as a
   skill candidate first (`.planning/knowledge/<name>.md`), then promote via
   writing-skills.
```

#### 2. SKILL.md — Step 4 (FTS/DB-sync caveat)
**File:** `bun-apps/pi-agent-ext-hermes-memory/skills/pi-memory-bulk-dedup/SKILL.md`
**Before:**
```
4. **FTS-orphan check.** After apply, the `.md` is source-of-truth and the DB
   re-hydrates on next startup sync; confirm no orphan rows remain by re-running
   a `memory_search` for a known-dropped entry (expect no hit).
```
**After:**
```
4. **FTS / DB-sync caveat.** The migration is `.md`-only — it does NOT reconcile
   the SQLite mirror. The startup `syncMarkdownMemories` only *upserts* (by content
   key, no DELETE), so after `apply` the dropped/compressed entries' DB rows
   **persist as stale search hits** until separately purged. The 40K budget IS
   still correctly reduced (it is computed from the `.md` via `entriesFor`), but
   `memory_search` will still surface orphan rows for dropped phrases — that is
   expected, not a failure. To purge orphans, delete the stale rows by content; a
   dedicated reconcile/purge command is a deferred operational-hardening follow-up.
```

#### 3. failure-model-migration.ts — Module docstring
**File:** `bun-apps/pi-agent-ext-hermes-memory/src/failure-model-migration.ts`
**Before:**
```
 * `.md`-first: operates on the markdown source-of-truth; the DB re-hydrates.
```
**After:**
```
 * `.md`-first: operates on the markdown source-of-truth. NOTE — this is a
 * `.md`-ONLY operation: it does NOT reconcile the DB. The startup mirror
 * (syncMarkdownMemories) only upserts by content key (no DELETE), so
 * consumed/compressed entries leave stale DB rows (still surfaced by
 * memory_search) until a separate purge. The 40K budget IS correctly reduced
 * because it is computed from the `.md`.
```

#### 4. memory-store.ts — Comment block
**File:** `bun-apps/pi-agent-ext-hermes-memory/src/store/memory-store.ts`
**Before:**
```
    // Topic-key recurrence WARNING (wayfind 2026-08-05 ticket 04, failureModel v1):
    // 2nd+ failure entry sharing a topic-key → flag it so the agent graduates the
    // recurring procedure to a skill (constants.ts:132 prompt rule) instead of
    // accumulating.
```
**After:**
```
    // Topic-key recurrence WARNING (wayfind 2026-08-05 ticket 04, failureModel v1):
    // 2nd+ failure entry sharing a topic-key → flag it so the agent graduates the
    // recurring procedure to a skill (the recurrence→skill prompt rule in MEMORY_POLICY_PROMPT, constants.ts) instead of
    // accumulating.
```

#### 5. topic-key.ts — Module docstring
**File:** `bun-apps/pi-agent-ext-hermes-memory/src/store/topic-key.ts`
**Before:**
```
 * Containment (near-dup.ts) catches wording-variants but misses *evolving
 * families* — the same subject re-captured across different incidents with low
 * token overlap (e.g. the `await_pr_merge` ×7 cluster). The TOPIC-KEY is the
 * subject entity used to group such families; it is also the signal the
 * recurrence→skill graduation prompt rule (constants.ts:132) keys on.
```
**After:**
```
 * Containment (near-dup.ts) catches wording-variants but misses *evolving
 * families* — the same subject re-captured across different incidents with low
 * token overlap (e.g. the `await_pr_merge` ×7 cluster). The TOPIC-KEY is the
 * subject entity used to group such families; it is also the signal the
 * recurrence→skill graduation prompt rule (the MEMORY_POLICY_PROMPT in constants.ts) keys on.
```

### Full Package Test Suite Result
```bash
( cd bun-apps/pi-agent-ext-hermes-memory && bun test )
```
**Result:** 1251 pass / 1 skip / 0 fail
✅ All tests passed — confirms NO executable line changed (logic unchanged).

### Commit Details
```
Commit hash: 91807ef0
Message: docs(memory): fix final-review findings — accurate DB-sync wording, drop stale line refs
Files changed: 4 files changed, 22 insertions(+), 11 deletions(-)
Paths:
  - bun-apps/pi-agent-ext-hermes-memory/skills/pi-memory-bulk-dedup/SKILL.md
  - bun-apps/pi-agent-ext-hermes-memory/src/failure-model-migration.ts
  - bun-apps/pi-agent-ext-hermes-memory/src/store/memory-store.ts
  - bun-apps/pi-agent-ext-hermes-memory/src/store/topic-key.ts
```

### Confirmation
✅ **NO executable line changed** — all 5 edits were comment/doc text only.
✅ Test suite passed with identical counts (1251 pass / 1 skip / 0 fail) — confirms no regression.
