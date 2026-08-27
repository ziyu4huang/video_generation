---
effort: 2026-08-26-kcard-multidir-rejudge
created: 2026-08-26
last: 2026-08-26 (effort COMPLETE — two parallel t03 measurements reconciled: recursive LOSES both times; D4; F2 all KEEP-UNPORTED; #2064 discharged)
status: complete
---

# Multi-directory corpus re-judgment of the recursive lane (D9 trigger + audit F2)

## Destination

The recursive resource lane is re-judged on a corpus where directory pruning
can actually express itself: the USB4 document FAMILY (main spec + 5 companion
specs + V1/V2 ECNs) as a genuinely multi-directory markdown tree. The eval
either shows the recursive lane beating the flat lane (→ reopen the
default/tool-wiring question) or confirms CLI-only (→ D9 stands with
multi-dir evidence). The audit's un-ported upstream knobs
(`DIRECTORY_DOMINANCE_RATIO`, `GLOBAL_SEARCH_TOPK`, `RetrieverMode`) are
adjudicated in the same pass (F2 fold-in) instead of staying un-ported fog.

## Context

- **Why now**: resource-tier D9 (measured 2026-08-25 on USB4, 21 blind
  TOC-derived questions, 4 arms × 2 runs, bge-m3) ruled the recursive lane
  CLI-only with root cause "the corpus is a single directory — directory
  pruning cannot express itself". D9's own closing line: "The next eval
  corpus MUST be multi-directory before the lane is re-judged."
  (`.planning/2026-08-25-kcard-resource-tier/map.md` D9.)
- **Corpus material verified on disk 2026-08-26**:
  `/Users/huangziyu/proj/study-news/ic-standard-spec/USB4 Specification November 2025/`
  holds the main spec (already file2md'd: `vlm-out/usb4-specification-2.0-november-2025-clean/`,
  839 pages, profile=paper) plus born-digital companions: Connection Manager
  Guide 2.0 (2.1M), DROM Specification (928K), Inter-Domain Service Spec 2.0
  (1.3M), DVSEC 1.0 (392K), Retimer 2.0 CLEAN, V1 ECN (~12 small PDFs),
  V2 ECN (~24 small PDFs). Skipped: REDLINE duplicates, Adopters Agreement
  (legal), TMU Simulation (zip — unsupported input).
- **file2md text mode smoke-tested 2026-08-26**: DVSEC → 14 pages,
  `provenance: text`, clean body text, seconds-fast, zero network.
- **Eval harness**: `bun-apps/scripts/resource-eval.mjs` currently hard-codes
  `pagesDir = corpus/pages` + flat `page-NNN` targets (lines 85-87, 121-131) —
  needs a multi-dir generalization (recursive page set, path-keyed targets).
- **Ingest walk is already recursive**: `resource-index.ts:walkTree` (lines
  149-173) skips dot-entries + tier sidecars; a nested tree indexes as-is.
  Doc-root combined `<slug>.md` files ARE walked as L2 — corpus assembly must
  strip them (navigation artifacts, not content).
- **L1 generation cost scales with DIRECTORIES, not pages** (32-sample bound,
  resource-tier t02): ~50 dirs in the planned tree ≈ ~50 LLM calls at ingest.

## Tickets

**Execution order:** 01 → 02 → 03 → 04 (strictly linear dependency chain —
02 needs the corpus, 03 needs the harness, 04 needs the numbers; no choice
pairs, order recorded per wayfind confirm-gate discipline).

### Phase 1 — corpus
- [01] Build the usb4-family multi-directory corpus — closed 2026-08-26 (1263 L2 rows / 86 dirs; receipt in ticket)

### Phase 2 — harness + battery
- [02] Generalize resource-eval.mjs for multi-dir trees + blind battery — closed 2026-08-26 (--check-only green; 844-row fog resolved)

### Phase 3 — judgment
- [03] Run the re-judgment + F2 adjudication — closed 2026-08-26 (reviewer-confirmed; recursive LOSES at every α)
- [04] Verdict, D9/D-map update, effort close-out — closed 2026-08-26 (D4 recorded)

## Decisions

- **D1 — corpus composition (user-confirmed 2026-08-26)**: main spec + CM
  Guide + DROM + Inter-Domain + DVSEC + Retimer CLEAN + ALL V1/V2 ECNs;
  `--extract text` mode. Reason: user directive "file2md use USB case just
  use it" + confirm-gate answers (include ECNs — they are the strongest
  directory-pruning signal; text mode — verified good on born-digital
  PDFs, fast, offline; figure fidelity does not matter for ranking eval).
- **D2 — corpus root is a NEW assembled copy, originals untouched**:
  `vlm-out/usb4-family/` next to the existing clean tree. Strip (a) stale
  tier sidecars copied from the main-spec tree (fresh generation for the new
  layout), (b) per-doc combined `<slug>.md` (would pollute L2 with a
  whole-doc duplicate). `manifest.json` stays (not `.md`, walk ignores it).
  Reason: the previous eval wrote sidecars into the live tree; a fresh copy
  keeps the study-news originals pristine and the fingerprint deterministic.
- **D3 — F2 fold-in scope**: t03 must end with an explicit per-knob verdict
  (PORT / KEEP-UNPORTED with reason) for `DIRECTORY_DOMINANCE_RATIO`,
  `GLOBAL_SEARCH_TOPK`, `RetrieverMode` — no silent non-decisions. Cheap
  env-gated sweeps only if implementation is trivial; otherwise the verdict
  is adjudicated from the measured runs + upstream reading.
- **D4 — the re-judgment verdict: recursive lane LOSES on the multi-dir
  corpus; CLI-only is now REDESIGN-gated, not re-tune-gated.** Measured
  2026-08-26 on usb4-family (1263 L2 + 170 tier rows, 26-question battery
  16 dir-class + 10 within-class, 4 arms × 2 identical runs, bge-m3):
  recursive 10/26 hit@5 MRR 0.215 vs flat 14/26 0.394; dir-class MRR loses
  at every α (best 0.275 @ α=0.3 vs flat 0.400); dir-class hit@5 loses at
  α=0.5/0.7, single TIE at α=0.3. Lexical-bias anomaly CUTS AGAINST
  recursive (13/16 dir questions name their doc — easy seeds — and it still
  loses; reviewer finding). F2 verdicts (all KEEP-UNPORTED, evidence in
  ticket 03): `DIRECTORY_DOMINANCE_RATIO` is a dead constant upstream;
  `GLOBAL_SEARCH_TOPK` is a reranker-scoped floor structurally surpassed
  (seed pass selects all tier rows, D19 = no reranker); `RetrieverMode` is
  the flat-vs-recursive fork kcard already exposes as two CLI surfaces.
  Reason: D9's single-dir excuse is now DISCHARGED with counter-evidence —
  directory pruning is actively harmful on the corpus type it was built
  for. Re-open only with a redesign hypothesis (seed scoring / descent
  policy), never with re-tuning.

## Frontier

(none — effort complete; the queue drained. Successor next-goal per session
SOP.)

## Fog of war

- ~~Whether the flat lane also gains from L0/L1 tier rows on a multi-dir
  tree~~ — RESOLVED t03: it does not (flat with tier rows 14/26 0.394 vs
  L2-only 15/26 0.401; receipt `ablation-flat-l2only-2026-08-26.json`).
  Tier rows exist for the recursive lane only.
- ~~α unidentifiable on single-dir (resource-tier fog)~~ — RESOLVED t03:
  identifiable on multi-dir (0.3/0.5/0.7 → 13/10/11 hit@5); the
  single-dir invariance was a corpus artifact as hypothesized. 0.5 default
  retained (moot under D4).
- ~~Question-battery authoring for companions~~ — RESOLVED t02: TOC-derived,
  targets spot-verified, page-offset pitfalls recorded in the battery meta
  (Inter-Domain +7 roman front matter).
- ~~The main-spec 839-row receipt vs 840 walked files discrepancy (combined
  root .md)~~ — RESOLVED t02: the 2026-08-25 receipt actually inserted
  **844** resource rows (839 pages + 1 combined root .md + 4 tier sidecar
  rows); "839" was the page-count shorthand. New corpus = exactly 1263 L2
  by construction (D2 strips the combined file).
- NEW observation, NOT re-litigated here: the generic-card baseline
  (`zk_ingest` generic → hierarchicalRetrieve) beat BOTH resource lanes on
  this corpus (17/26 0.449 vs flat 14/26 0.394) — consistent with the
  2026-08-25 "no clear win vs generic". The resource tier's standing
  justification remains its derived/rebuildable/token-economics posture
  (that effort's D2), not retrieval supremacy; any future "should the
  default document lane be generic cards instead" question is its own
  effort with its own battery.
- POST-SWEEP REPRODUCTION (2026-08-28, after the #2090/#2098 corpus-wide
  sidecar regeneration): 4-arm battery re-run on the fully-swept tree
  (receipt `output/resource-eval/receipt-2026-08-27T21-26-18-333Z.json`,
  2 identical runs). vs the FIXED baseline (13-16-57): recursive 10→13
  hit@5 / MRR 0.215→0.281 (the resolvable-link L1s genuinely help the
  tier-descending lane); flat 14→14 / 0.394→0.362 (stable, shuffle
  noise); generic-hier 17→17 / 0.449→0.453 and generic-flat-vector
  15→15 / 0.406→0.427 — generic lanes are byte-identical inputs
  (sidecars are dot-entries, never in the generic page set), so
  unchanged scores are the mechanically expected outcome. D4 stands.
  TRAP (measured the hard way): `output/resource-eval/` receipts are
  PER-WORKTREE scratch — comparing against this worktree's 13-13-20
  receipt (the broken 839-leaf run) manufactures a phantom
  "generic-hier +11 hit@5 jump"; always cross-check the
  Parallel-session note below before treating a receipt as THE baseline.

## Cross-effort links

- Builds-on: `.planning/2026-08-25-kcard-resource-tier/` — D9 named this
  corpus as the re-judgment trigger; α fog + L0/L1-ablation re-opens rode
  along and both RESOLVED here (see Fog). That map's D9 now carries the
  resolution pointer to this effort's D4.
- Shares-decision-with: `.planning/specs/2026-08-25-openviking-naming-alignment-audit.md`
  — F2 (un-ported retrieval knobs) folds into t03 per that audit's §E.

## Parallel-session note (record, not decision)

Ticket 03 was measured TWICE by concurrent worktrees (`__memory`: receipts
13-13-20, a 1431-row index that raced the tier-sidecar writes, broken
generic baseline, closed via PR #2066; `__subagent`: receipts 13-16-57+,
full 1433-row index, fixed baseline, closed via the reconciling PR). Both
reviewer passes approved their own records; the verdict (D4) is identical,
and the α=0.3/0.7 cells reproduce exactly across both. Lesson for parallel
dispatches: never run the live eval while another session's
resource-ingest is still writing sidecars into the same tree — the index
row count is a race surface (1431 vs 1433).
