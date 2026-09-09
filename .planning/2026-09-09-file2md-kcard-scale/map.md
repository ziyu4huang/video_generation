---
effort: 2026-09-09-file2md-kcard-scale
created: 2026-09-09
last: 2026-09-09
status: done
---

# Wayfinder map: 2026-09-09-file2md-kcard-scale — broader arXiv corpus as the pipeline experiment

## Destination

Scale the file2md → kcard pipeline from 3 same-day cs.CL papers to a
broader 10-paper corpus (cs.CV multimodal, cs.AI agents, stat.ML theory,
cs.CR security), let the corpus EXPOSE pipeline weaknesses, fix the
measured ones in code (figure-caption heuristic, vision grounding,
generic-adapter leak), land ~10 reviewer-audited kcards converged into the
vault graph, and close via the standard PR chain.

## Context

Planner-led (`arc-plan.ts`, hard-problem/zai/glm-5.3, 438 s, 4/6 reads —
`output/arc-plan-file2md-kcard-scale/plan.md`). Measured by the executor
before ticket finalization (experiment-first):

- **Corpus**: 10 papers, all 2026-09-08 v1, spanning SyncWorld (world
  models, 24 pp, 20 MB figure-heavy), Image Tokenizers (27 pp), Canonical
  Color (12 pp), Co-Evolving Harnesses (10 pp), ExecCritic (35 pp),
  Amari Bayesian Duality (17 pp, math-heavy), Transformers as In-Context
  Samplers (26 pp), PrivEscalate (18 pp), GMSBench (5 pp), Supply-Chain
  Measurement (6 pp). All convert clean: 180 pages, 0 failures.
- **Measured heuristic gap** (the arc's headline finding): the legacy
  `FIGURE_CAPTION_RE` (`Figure N-x.`, caption-only ≤1300 chars) fired
  **0 / 180 pages**; 53 pages carry modern `Figure N:` captions with body
  min 1452 / median 3792 / max 6286 chars — the modern figure-page shape
  is caption+text, not caption-only.
- **Fix (landed)**: new `isCaptionFigure` — colon-required modern caption
  (`Figure N:`; references like "Figure 1 shows"/"in Figure 1." cannot
  fire) + `FIGURE_CAPTION_PAGE_MAX_CHARS = 3000` band. Re-run: **9 pages
  detected, 9/9 vision-enhanced, 0 degraded** (was 0/180). 5 new figure
  tests; suite 335/335.
- **Vision grounding fix (landed)**: `src/vlm/ground.ts` — deterministic
  pre-check (numbers = hard verbatim check; named runs script-aware so a
  Chinese description of an English page paraphrases by design). 10 tests,
  including the review's verified fixture (92% similarity bullet grounds;
  a 87% variant flags).
- **Adapter leak fix (landed)**: generic family stops harvesting
  [[wiki-link]] targets into tags (structural 連結 links, not concepts —
  sibling card titles were leaking into tags and the note `sources`
  label); zk_ingest tool now assigns PER-FILE source labels for generic
  multi-file ingests (was files[0]'s title for ALL); leading-H1 double
  render stripped. Regression tests in ingest-generic.test.ts.

## Tickets

- [x] `tickets/01-corpus-baseline.md` — 10-paper selection + conversions +
      measured fire-rate table (this map's Context; raw receipts in
      `receipts/`)
- [x] `tickets/02-figure-caption-fix.md` — isCaptionFigure + band + tests
- [x] `tickets/03-vision-ground-module.md` — src/vlm/ground.ts + tests
- [x] `tickets/04-generic-adapter-leak.md` — adapters.ts harvest removal +
      per-file source labels + H1 dedup + tests
- [x] `tickets/05-kcards-waves.md` — 10 kcards (anchors on numeric bullets,
      ground-checked vision bullets) + convergence with on-disk verification
- [x] `tickets/06-reviewer-audit.md` — glm-5.3 read-the-artifact audit,
      MISATTRIBUTED = 0 gate, blockings fixed in-card
- [x] `tickets/07-merge-closeout.md` — vault PR → parent PR (improvements +
      planning artifacts) → close-out + successor

## Decisions

- D1 experiment-first: fixes landed only after the corpus measured the gap
  (the 0/180 table is the ticket-02 evidence).
- D2 modern caption = colon-required (`Figure N:`); references cannot fire.
  Deviation from planner D2 ("band unchanged"): measured — band-unchanged
  fires ZERO on the modern corpus (min caption-page body 1452 > 1300), so
  a second named constant band (3000) is the fix; legacy shape/constants
  untouched for the USB4-spec corpus.
- D3 ground.ts is pure + IO-free in file2md `src/vlm/` — shared by the
  card lane and the bench's phase 1b; numbers hard-check, named runs
  script-aware (cross-language paraphrase is by design).
- D4 generic family drops wiki-link tag harvest (structural links); other
  families keep theirs.
- D5 every numeric bullet in a kcard names its Table/Figure + page anchor;
  vision bullets carry the glm-5.3-flash provenance label and pass
  ground.ts before admission.
- D6 corpus PDFs/page-md stay gitignored under `output/`; the committed
  record is the manifest + receipts with measured numbers.
- D7 convergence only via the bridge with explicit vault + on-disk
  verification.
- D8 1 card per paper (the strong method/results split case did not
  materialize in this corpus; single cards keep convergence simple).

## Fog of war resolutions

- Telemetry shape: manifest `pages[].figure {detected, enhanced}` — verified
  consumable (the receipts table is built from it).
- arxiv category filter: `category` param works (4-category search returned
  on-topic papers).
- Scan-provenance arm: no scan PDF in this corpus — `isScanFigure` stays
  unmeasured (noted; bench owns a scanned fixture).

## Cross-effort links

Builds-on: `2026-09-09-file2md-kcard-pipeline` (the pipeline + review this
arc scales), `2026-09-08-file2md-svg-pptx-vision` (vision-guarantee rules
D4/D16 — the ground.ts gate enforces them). Shares-decision-with: the
bench-kcards design (review §3) — ground.ts IS bench lane 1b's
deterministic pre-check.

## Shipped-as

- pi-agent-vault#26 (squash 3cfba3a): 10 kcards + 13 graph notes + MOC +
  semantic-index convergence (pointer pinned by this repo's merge).
- Parent PR (this branch): pipeline fixes — figure.ts `isCaptionFigure`
  (0/180 → 9/9 detected+enhanced), `src/vlm/ground.ts` grounding gate,
  generic-adapter de-leak + per-file source labels in the zk_ingest tool.
- Reviewer audit: PASS-with-fixes (glm-5.3, read-the-artifact; 3 blockings
  + 4 should-fix/nits — ALL fixed in-card with correction records;
  receipt `receipts/reviewer-audit-2026-09-10.md`).
- Known wart filed for the bench: pure-CJK-title generic cards fall back
  to the collision-prone `generic-paper.md` slug (observed on 軟體供應鏈).
