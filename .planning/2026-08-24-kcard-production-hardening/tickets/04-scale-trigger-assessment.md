---
type: task
status: open
---

# 04 — SurrealDB scale-trigger assessment (D03 nearing)

## Question

Have card/relation counts crossed the knowledge-pipeline D03 thresholds (≈2k cards / ≈5k relations) now that Core-5 ingest lanes are live, and what relation-index decision does that force?

## What to build

A measured assessment against the live `context_db`: active card count (leaves + agg), relation count, index sizes, and the D03 verdict. If under threshold: record the headroom and the re-check trigger. If over (1925 cards at effort-open, extraction lanes now writing): write the relation-index decision (or fold the work back to the knowledge-pipeline effort with a cross-effort link) — per-level BFS cost was measured fine at ticket 03, but the trigger exists for a reason.

## Acceptance

- [ ] Measured count receipt from the live index (card/relation/size, date-stamped)
- [ ] D03 verdict recorded in the map: under (headroom + re-check trigger) or over (decision linked/folded)
- [ ] No code unless the verdict is over — then the decision names its own follow-up ticket or fold-back link
