---
type: feature
status: open
claimed:
blocked by: [12]
---
# 13 — knowledge-card megafile split (K1–K3)

Split the three megafiles (K1–K3) along the module seams surfaced by dedup ticket 12:

- **K1** `ingest.ts` 1767 LOC → adapters/ + render/ + engine
- **K2** `extensions/knowledge-card.ts` 1506 LOC → task builders to src/; tools split per-tool
- **K3** `retrieve.ts` 1102 LOC → extract graph-health module

## Precondition

Ticket 12 landed — splitting before dedup would duplicate the work (the dedup helpers define the seams the splits cut along).

## Acceptance (deletion-test gate)

- Module responsibilities single-line-declarable: each split module's purpose fits one sentence, no "and".
- No re-export shims left behind — imports point at the real new homes.

## Estimate
M
