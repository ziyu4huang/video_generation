---
effort: 2026-09-10-kcard-blend-lift
created: 2026-09-10
last: 2026-09-10
status: done
---

# Wayfinder map: 2026-09-10-kcard-blend-lift — production-path measurement + the golden-protocol fix

## Destination

Measure retrieval through the PRODUCTION ranker (not the raw-cosine
diagnostic), diagnose the measured gap, and land the first correct
measurement surface: `production.ts` (inferQueryTags + buildRetrieveOptions
+ retrieveRecords — the exact knowledge_query symbols) over CARD-GROUNDED
golden questions (protocol v2). Baseline recorded: **production MRR 0.312**
(card-grounded, embed tier) vs 0.138 on the flawed paper-grounded v1 set.

## Context

Planner-led (arc-plan.ts, hard-problem/zai/glm-5.3, 295 s — receipt
`receipts/planner-plan.{md,json}`). The planner corrected the framing with
file:line evidence (§5): zk_ask is an LLM pipeline whose 0.7×search+0.3×links
score is NOT blendScore — the blend belongs to `retrieveRecords`' flat-
semantic and hier lanes; the prior arc's baselines (0.692/0.153) were
measured on lanes production never serves.

## Executor findings (this arc's real deliverable)

- **Golden-protocol flaw (decisive)**: v1 goldens authored from 15-page
  paper extraction made **143/146 (98%) questions unanswerable from the
  distilled cards** — the MRR "gap" measured retrieval against answers the
  vault never stored. Measured: production MRR 0.138 on v1; 101/146 notes
  absent from the top-50 candidate set entirely.
- **Protocol v2 (landed)**: `fixtures/golden-v2/` — 13 files authored by a
  glm-5.3 judge reading the CARD FILES, questions answerable purely from
  card content, token-overlap ground-truth check (≥50% answer coverage,
  all 13 pass).
- **Production baseline**: MRR 0.276–0.312 (embed run-to-run band),
  hit@3 ≈ 0.33 — measured through the served boundary
  (`inferQueryTags` → `buildRetrieveOptions` → `retrieveRecords`).
- **Tokenizer extracted**: `inferQueryTags` now exported from host-fns;
  the tool execute imports the shared symbol (zero-drift).

## Tickets

- [x] `01-production-lane.md` — production.ts + v2 goldens + measurement
- [x] `02-protocol-v2.md` — the card-grounded authoring protocol + validation
- [ ] `03-blend-lift.md` — the remaining lift (T2 flat-blend cap, T3 CJK
      tokenization, T4 summary richness) — successor queue head

## Decisions

- D-v2: goldens are authored from CARD content (retrieval measures "find
  the card whose content answers the question"); paper-detail questions
  belong to answer-generation evaluation, not retrieval.
- D-prod: the measurement boundary is `buildRetrieveOptions` + `inferQueryTags`
  (the served symbols); the raw-cosine lane stays as a diagnostic column.
- D-run-band: embed run-to-run jitter band ±0.05 on MRR — thresholds compare
  against the recorded receipt, not a single run.

## Known remaining (successor queue)

- Flat-blend α-cap (planner D4): lexical-only targets cap at α=0.18; the
  hier lane's absolute stem term is the structural fix (red-test-first).
- 48/78 card-grounded questions still rank-0 — CJK-titled cards
  (Amari, Canonical Color) fail the tag filter; CJK bigram tokenization
  (planner T3) is the candidate fix.
- v1→v2 golden migration: the old `fixtures/golden/` stays for provenance;
  gates consume `golden-v2/`.

## Cross-effort links

Builds-on: `2026-09-10-kcard-quality-lift` (embed-composition fix + the
amendment this arc resolves), `2026-09-10-bench-kcards` (the instrument).

## Shipped-as

PR (branch kcard-blend-lift): production lane + golden-v2 + tokenizer
extraction (knowledge-card) + measured baselines recorded in receipts.
