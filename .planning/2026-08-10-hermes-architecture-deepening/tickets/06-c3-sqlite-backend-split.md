---
type: task
status: open
claimed:
blocked by: 05 (zk audit gates the wave)
---
# 06 — C3 sqlite-backend split

Extract corruption-recovery (~600 LOC) from `src/store/sqlite/sqlite-backend.ts` (1506 LOC) into its own module + a separate schema migration.

## Invariant
- The `memories` column list is declared EXACTLY ONCE across the split modules — no second copy may drift in.

## Acceptance
- Deletion-test gate: remove the corruption-recovery module and the core backend suite stays green (and vice versa).
- Separate schema migration preserved; corruption-recovery never re-inlined.
- Full hermes suite green.

## Notes
- Sequencing: gated by ticket 05 (zk audit); kp21 drift (ticket 07) follows this.
- Prior art for the invariant: the 2026-08-13 fix wave found corruption-recovery `copyMemories` silently dropping 6 columns (md_id/state/severity/pin/frontmatter/graph) — exactly the duplicate-column-list drift this invariant kills.
