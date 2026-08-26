# 04 — Verdict, D9/D-map update, effort close-out

Status: closed 2026-08-26 · Blocked by: 03 (closed)

## What

Translate t03's numbers into the standing decision: does the recursive lane
stay CLI-only (D9 stands, now with multi-dir evidence) or does it earn a
default/tool-wiring re-open (new ticket in a follow-on effort, NOT this one)?
Update the resource-tier map's D9 + fog lines and this map; close out.

## Receipt (2026-08-26)

- **D4 recorded in this map** (see map `## Decisions`): recursive lane LOSES
  on the multi-dir corpus — overall at every α, dir-class MRR at every α,
  dir-class hit@5 everywhere except a single α=0.3 TIE. CLI-only is now
  redesign-gated, not re-tune-gated.
- **F2 all three knobs KEEP-UNPORTED** (per-knob evidence in ticket 03;
  one dead constant, one reranker-scoped floor structurally surpassed, one
  enum fork already expressed by the two CLI surfaces).
- **Resource-tier map updated append-only**: a resolution pointer on D9 and
  both "re-open only with the multi-dir corpus" fog items (α, L0/L1
  ablation) now point at ticket 03's receipts.
- **This map**: status complete; fog items struck with receipts; one new
  observation recorded (generic baseline beats both resource lanes on this
  corpus — consistent with the 2026-08-25 "no clear win vs generic", and
  NOT re-litigated here: the resource tier's justification is its derived/
  rebuildable/token-economics posture (D2 of that effort), not retrieval
  supremacy).

## Done when

- [x] Verdict D-number recorded (map D4) with both-corpus evidence
- [x] Resource-tier map D9 carry-over line updated (pointer, no rewrite)
- [x] Resolved fog items struck with receipts; unresolved ones named
- [x] Map `status: complete`; effort folder committed + merged
