---
name: pi-memory-bulk-dedup
description: Bulk-dedup the hermes-memory failure store — near-dup + topic-family collapse, resolved-compression, recurrence→skill graduation. Dry-run + backup + diff before any destructive apply.
---

# Bulk dedup the failure-memory store

Use when `memory_search(target="failure")` or a staleness audit shows recurring
topics / near-duplicates crowding the 40K-char failure budget (the
`await_pr_merge` ×7 pattern), and `config.failureModel` is `"v1"`.

## When to use

- The failure store is near its `failureCharLimit` (default 40K).
- A write-gate `⚠ recurring topic` warning fired and you want to consolidate.
- A staleness audit (`memory` tool, action `audit`) lists resolved/stale entries.

## Procedure

1. **Dry-run the deterministic canonicalization** (no LLM, auditable diff). The
   canonicalizer is `canonicalizeFailureBacklog` in
   `bun-apps/pi-agent-ext-hermes-memory/src/failure-model-migration.ts`. Run a
   dry-run against the store and READ the printed diff:
   ```bash
   ( cd bun-apps/pi-agent-ext-hermes-memory && bun -e "import {canonicalizeFailureBacklog} from './src/failure-model-migration.ts'; const r = canonicalizeFailureBacklog({ failuresPath: process.env.HOME + '/.pi/agent/pi-hermes-memory/failures.md', dryRun: true }); console.log(r.diff); console.error('scanned='+r.scanned+' nearDup='+r.nearDupCollapsed+' topic='+r.topicCollapsed+' compressed='+r.compressed+' dropped='+r.dropped);" )
   ```
   The diff shows three tiers: near-dup wording collapse (longest-wins),
   topic-family collapse (most-recent/resolved wins), and resolved→one-line-fact
   compression. Active unique entries are never touched.

2. **Review the diff.** Confirm no unique lesson is dropped (REJECTED.md:
   destructive consolidation must not silently drop a unique lesson). If a
   collapsed family is a recurring *procedure* (≥2 captures), that is the
   graduation signal — capture it as a skill candidate first
   (`.planning/knowledge/<name>.md`), then promote via writing-skills.

3. **Apply with backup.** Only after the diff is confirmed, apply with
   `backup: true` so `failures.md.bak` preserves the pre-image:
   ```bash
   ( cd bun-apps/pi-agent-ext-hermes-memory && bun -e "import {canonicalizeFailureBacklog} from './src/failure-model-migration.ts'; const r = canonicalizeFailureBacklog({ failuresPath: process.env.HOME + '/.pi/agent/pi-hermes-memory/failures.md', dryRun: false, backup: true }); console.log('applied: '+r.dropped+' dropped, '+r.compressed+' compressed, '+r.finalChars+' chars. backup at failures.md.bak');" )
   ```

4. **FTS-orphan check.** After apply, the `.md` is source-of-truth and the DB
   re-hydrates on next startup sync; confirm no orphan rows remain by re-running
   a `memory_search` for a known-dropped entry (expect no hit).

## Pitfalls

- Never run apply without reading the dry-run diff first.
- Never hard-delete a unique active entry — only consumed dupes / superseded.
- Graduation is agent-driven: warn + recommend; do NOT auto-create skills.
- Legacy entries without a topic-key simply don't group until they recur — no
  forced migration.

## Verification

- `failures.md.bak` exists and equals the pre-apply content.
- Post-apply char total < pre-apply (from the result struct's `finalChars`).
- A `memory_search` for a dropped canonical phrase returns the surviving
  canonical entry, not orphans.
