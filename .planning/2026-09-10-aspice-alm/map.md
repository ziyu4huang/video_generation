---
effort: 2026-09-10-aspice-alm
created: 2026-09-10
last: 2026-09-10
status: done
---

# Wayfinder map: 2026-09-10-aspice-alm — ASPICE 4.0 / ALM vertical for archify

## Destination

archify produces ALM / ASPICE 4.0 assessment artifacts end to end from
data-driven surfaces: two shipped layout templates (`aspice-bp` BP coverage
board, `pa-rating` capability strip), a worked illustrative assessment deck
authored as a canonical JSONL envelope (`examples/aspice4-alm/assessment.deckl`)
with the ALM workflow documented (evidence edit → repack → unpack → build), the
manifest parity contract covering the new slot fields, and zero engine changes.

## Context

- Plan (GLM-5.3 planner, grounded via web on the ASPICE 4.0 PAM — VDA QMC
  2023-11-29; HWE.1–4 / MLE.1–4 / SUP.11 new; ~10 processes removed; all BPs
  reworked): `.planning/plans/2026-09-10-aspice-alm-plan.md`.
- Builds on the deck-html effort (#2207 determinism, #2211 deck.html, #2241
  pack/unpack) and its parity-contract discipline (#2255).

## Shipped

- **t-D**: verdict — NO `aspice` IR type / NO engine change (data-driven only).
- **t-A**: `templates/aspice-bp.layout.json` + `templates/pa-rating.layout.json`
  (12 shipped templates), goldens, slot-gate negatives (missing/over-full),
  GENERAL_RICH_TEMPLATES renames, README/skill-doc counts.
- **t-B**: `examples/aspice4-alm/` — 8-slide assessment deck authored as
  canonical JSONL (pack bytes), README with the repack + slideCount-guardrail
  workflow; byte-stability drift pin in tests/deck-pack.test.ts.
- **t-C**: manifest schema gains `process`/`attribute`/`bps`/`ratings`
  (`why` calibrated to STRING per decision.layout.json truth); contract tests
  for the new slot shapes (dual-gate + registry-aware parse).

## Decisions

- **D1**: no `aspice` IR type — diagram needs compose from existing
  architecture/workflow IRs; engine/vendored churn rejected (verified against
  src/validate.ts forwarding).
- **D2**: schema stays structural — verdict/rating vocabularies (SAT/PART/MISS,
  N/P/L/F) documented in slot descriptions, NOT enum-constrained (parity
  authority split; enum would make the schema stricter than runtime).
- **D3**: per-evidence JSONL record format descoped — the deck envelope's
  line-per-slide already models the assessment grain (follow-up if a real
  assessor workflow needs sub-slide lines).
- **D4**: reviewer pass 2 verdict PARTIAL → findings F1–F4 + F7 resolved, F5
  (3 missing-source info notes) fixed after the review, NEW-1 README flow
  reworded, OBS-1 drift pin added. Review artifacts:
  /tmp/aspice-plan/review-aspice-result.md + review-aspice-followup-result.md.

## Tickets

- [x] t-D — engine-change evaluation (verdict: no)
- [x] t-A — layout templates + goldens + slot-gate negatives
- [x] t-C — manifest-schema parity entries + contract tests
- [x] t-B — example assessment deck + ALM workflow (JSONL-authored)
