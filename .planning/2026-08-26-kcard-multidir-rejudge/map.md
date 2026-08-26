---
effort: 2026-08-26-kcard-multidir-rejudge
created: 2026-08-26
last: 2026-08-26 (t01 closed — corpus built, 1263 L2 / 86 dirs)
status: active
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
- [02] Generalize resource-eval.mjs for multi-dir trees + blind battery — open

### Phase 3 — judgment
- [03] Run the re-judgment (recursive vs flat vs generic ×2) + F2 knob adjudication — open
- [04] Verdict, D9/D-map update, effort close-out — open

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

## Frontier

Ticket 02 — the corpus exists (t01 closed); the flat-`pages/` assumption in
`resource-eval.mjs` is now the blocker for everything downstream. The
battery authoring is the careful part (TOC spans, dir-discriminating
majority); the script change itself is small.

## Fog of war

- Whether the flat lane also gains from L0/L1 tier rows on a multi-dir tree
  (t03's arms measure this as a side-effect; the t04 α-re-identification
  question from resource-tier fog rides along).
- Question-battery authoring for companions: TOC-derived like the main-spec
  set (its lesson: key sections to page SPANS, not the heading page —
  resource-tier map fog, answer-key granularity).
- The main-spec 839-row receipt vs 840 walked files discrepancy (combined
  root .md) — resolve as a side-check while assembling (D2 stripping makes
  it moot for the new corpus, but the old receipt's count deserves a note).

## Cross-effort links

- Builds-on: `.planning/2026-08-25-kcard-resource-tier/` — D9 named this
  corpus as the re-judgment trigger; α fog + L0/L1-ablation re-opens ride
  along (both were "re-open only with the multi-dir corpus").
- Shares-decision-with: `.planning/specs/2026-08-25-openviking-naming-alignment-audit.md`
  — F2 (un-ported retrieval knobs) folds into t03 per that audit's §E.
