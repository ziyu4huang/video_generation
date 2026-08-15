---
type: task
status: closed
---
# 01 — C1 codec unification (close-out)

## Resolution
C1 v1 SHIPPED as #1196 (2026-08-11): `splitFencedYaml` leaf in `src/store/frontmatter-codec.ts`; memory-format, knowledge-serializer, skill-utils, merge-plan, memory-store (decodeEntry/mdIdOf/isPinned), image-serializer all delegate; `split(ENTRY_DELIMITER)` consolidated to one site (memory-serializer.ts:90).

Residual (this ticket): `planning-parse.ts` hand-rolled copy added post-leaf (1fcb4504) — rewired to the leaf + sole-source regression gate added. C1 CLOSED.

Acceptance bar (grilled 2026-08-15): byte-identical round-trip for all 5 serializer kinds; zero non-leaf fence-splits (grep gate); full hermes suite green.
