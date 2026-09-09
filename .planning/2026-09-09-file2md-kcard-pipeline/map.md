---
effort: 2026-09-09-file2md-kcard-pipeline
created: 2026-09-09
last: 2026-09-09
status: done
---

# Wayfinder map: 2026-09-09-file2md-kcard-pipeline — arxiv → file2md → kcards, glm-5.3 review, bench design

## Destination

One pipeline run proving file2md as the paper→knowledge-card bridge: search
recent LLM papers (research-tool arxiv lib), convert with file2md
(`--extract smart` + glm-5.3-flash figure descriptions via `askImage`), land
reviewer-audited kcards in the vault, converge them into the knowledge graph,
and get an independent glm-5.3 reviewer to (a) audit the pipeline and
(b) design its quality benchmark. All content merged to both defaults
(vault submodule + this repo), benchmark design adopted as the successor
queue head.

## Context

Single-session arc (no planner dispatch — the pipeline steps were
user-directed and executed interactively). Measured:

- 3 papers picked from arXiv cs.CL submittedDate desc (all 2026-09-08):
  2609.09156 ReCite, 2609.09153 Procedural Graphs, 2609.09090 SPINE.
  PDFs → `file2md --extract smart --scale 2` (14/36/21 pages, all
  text-provenance) → figure pages rasterized + described via
  `src/vlm/ask.ts askImage` on zai/glm-5.3-flash.
- 3 kcards written to `Zettelkasten/Paper - *.md` (house format,
  cross-linked, `sources: ["arXiv:<id>"]`).
- Independent reviewer dispatched via `spawnSubagent` (hard-problem def,
  model double-pinned zai/glm-5.3, 369 s, ~446k tokens): verdict **REWORK**
  with 2 blockings + 3 should-fix + 3 nits — full review + benchmark design
  at `receipts/review-glm53-2026-09-09.md`.
- Blockings verified and fixed in-session: ReCite card cross-table number
  misattribution (89.71 was Position-Only F1 compared against Table 4's
  37.81; true strict end-to-end is 39.15 vs 10.32); convergence bypass
  (direct writes invisible to semantic index + graph → fixed via
  `zk_ingest generic` through the s2-agent bridge, artifacts verified:
  3 graph notes + bge-m3 re-embed + MOC update). PG 6→7 benchmark count and
  SPINE 23+1-control labeling also fixed.

## Tickets

- [x] `01-pipeline-run.md` — search → file2md → figure vision → 3 kcards
- [x] `02-reviewer-audit.md` — glm-5.3 reviewer REWORK; blockings verified
      and fixed; corrections recorded in-card
- [x] `03-convergence.md` — zk_ingest generic into s2-agent-vault (artifact-
      verified; note the bridge's first run claimed success with zero disk
      writes — always verify artifacts, never the session's claim)
- [x] `04-merge.md` — vault PR pi-agent-vault#25 (squash, fc309c2) + this
      repo's pointer bump + planning artifacts PR

## Decisions

- D1: cards carry correction records inline (reviewer-audit provenance)
  rather than silent edits — knowledge corruption stays visible.
- D2: vault content merges via the submodule's own PR flow
  (pi-agent-vault#25); the parent pins the merged commit — never pin an
  unmerged submodule state.
- D3: the glm-5.3 reviewer's benchmark design is adopted verbatim as the
  successor queue head (`bench-kcards` package, two-sided build/query,
  scorecard + regression gates; see receipts/review §3-4).
- D4: `output/` scratch is never the durable home — the review + receipt
  are copied into this effort folder.

## Fog of war resolutions

- Bridge zk_ingest vault resolution: first run targeted/claimed the wrong
  vault with zero artifacts; explicit `vault` param + on-disk verification
  is the only trustworthy invocation (recorded; candidate `zk_card check`
  orphan-detector improvement lives in the benchmark's build order).
- Generic-adapter wart: wiki-links can leak into graph-note `sources`/
  `tags` fields (seen on generic-paper-recite) — phase 1c structural lane
  of the benchmark should pin it.

## Cross-effort links

Builds-on: `2026-08-23-file2md-vision-extraction` (askImage seam),
`2026-09-08-file2md-svg-pptx-vision` (vision = interpretation, not ground
truth — the exact failure class finding 1/4 enforce against).
Superseded-by-nothing; successor: bench-kcards implementation (next-goal
20260909-052625 → superseded by a new successor at this arc's close-out).

## Shipped-as

- pi-agent-vault#25 (squash fc309c2): 3 kcards + 3 graph notes + MOC +
  convergence.
- This repo: submodule pointer pinned to fc309c2 + this effort folder
  (PR filed from branch `file2md-kcard-pipeline`).
- Review + benchmark design: `receipts/review-glm53-2026-09-09.md`.
