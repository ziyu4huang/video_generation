# Task 3 — Write-gate topic-key recurrence → skill warning (failureModel v1)

**Branch:** `build/failure-model-v1`
**Commit:** `b175c33ee707451e5be360995e4b5e162a87245a`
**File touched:** `bun-apps/pi-agent-ext-hermes-memory/src/store/memory-store.ts` (1 file, +12 lines)

## What this task does

Wires the pure `findTopicRecurrence` + `formatTopicRecurrenceWarning` pair (Task 2)
into the failure write path (`_addInner`), gated on `config.failureModel === "v1"`.
Under legacy (default) the new branch is dormant, so legacy behavior is
byte-identical. The warning is appended to the existing `nearDupNote` so every
return path that already surfaces near-dup notes carries the recurrence note too.

## Edit 1 — import (line 45, immediately after the near-dup import)

```typescript
import { DEFAULT_NEAR_DUP_THRESHOLD, findNearDuplicate } from "./near-dup.js";
import { findTopicRecurrence, formatTopicRecurrenceWarning } from "./topic-key.js";
```

## Edit 2 — gated append in `_addInner` (immediately after the near-dup `if` block)

Insertion point — the closing `}` of the `if (nearDupThreshold > 0) { … }`
block is the last line before the inserted block; nothing in the near-dup block
was modified. Surrounding context (~5 lines before + inserted block):

```typescript
    if (nearDupThreshold > 0) {
      const hit = findNearDuplicate(content, strippedEntries, nearDupThreshold);
      if (hit) {
        nearDupNote = ` ⚠ near-duplicate of an existing entry (${(hit.similarity * 100) | 0}% overlap): "${hit.preview}…". Consider \`memory replace\` to consolidate instead of accumulating near-dups.`;
      }
    }

    // Topic-key recurrence WARNING (wayfind 2026-08-05 ticket 04, failureModel v1):
    // 2nd+ failure entry sharing a topic-key → flag it so the agent graduates the
    // recurring procedure to a skill (constants.ts:132 prompt rule) instead of
    // accumulating. Warning only; graduation execution is agent-driven. Gated on
    // v1 so legacy behavior is byte-identical. Appended to nearDupNote so every
    // return path that surfaces nearDupNote carries it.
    if (target === "failure" && this.config.failureModel === "v1") {
      const topicHit = findTopicRecurrence(content, strippedEntries);
      if (topicHit) nearDupNote += formatTopicRecurrenceWarning(topicHit);
    }
```

`target`, `content`, and `strippedEntries` are all parameters / locals already in
scope in `_addInner` (they are consumed by the near-dup block directly above).
`this.config.failureModel` is the config field added in Task 1.

## Suite result (full package)

`( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`

```
 1248 pass
 1 skip
 0 fail
 1032 expect() calls
Ran 1249 tests across 98 files. [13.19s]
```

All green. No regression — the new branch is dormant under the default
`failureModel === "legacy"` config, so existing tests are unaffected.

## Gate verification

```
$ grep -n "this.config.failureModel" …/memory-store.ts
1040:    if (target === "failure" && this.config.failureModel === "v1") {
```

Exactly **ONE** hit. It is inside `if (target === "failure" && this.config.failureModel === "v1")`.
`failureModel` is never read without the `"v1"` equality check.

## Typecheck

`( cd bun-apps/pi-agent-ext-hermes-memory && bun run check )` → `tsc --noEmit`
produced no errors (clean).

## Deviations

None. Per the plan, **no new test** was added — the warning logic is the pure
`findTopicRecurrence`/`formatTopicRecurrenceWarning` pair already covered by
Task 2's 8 tests; this task is a config-gated string append whose correctness is
verified by the full suite staying green + the grep gate check above.
