---
effort: 2026-09-10-bench-kcards
created: 2026-09-10
last: 2026-09-10
status: done
---

# Wayfinder map: 2026-09-10-bench-kcards — the kcard build/query quality benchmark, implemented

## Destination

The designed benchmark (kcard-pipeline arc review §3–4) becomes a working
package: `bun-apps/bench-kcards/` with DETERMINISTIC lanes green in plain
`bun test` (1c structural, 1a extraction-faithfulness proxies, 2c tag
recall, T4 convergence harness with idempotence + orphan gates) and
BENCH_LIVE=1 lanes emitting a scorecard receipt (1d card faithfulness with
the MISATTRIBUTED=0 hard gate + planted fault, 2d retrieval MRR + bite
check). First receipt recorded; thresholds honestly reported.

## Context

Planner-led (arc-plan.ts, hard-problem/zai/glm-5.3, 295 s, 4/6 reads —
receipt `receipts/planner-plan-2026-09-10.{md,json}`). Implemented per the
plan's T0–T7 with these executor resolutions of the planner's fog items:

- knowledge-card had NO lib face (`src/index.ts` absent — planner's §5.4
  confirmed) → created additively (ingestRecords / retrieveRecords /
  readCardMeta / adaptGenericMarkdown / types); extension layer untouched.
- 2d primitive: `retrieveRecords` (tags lane) + `embedQuery` × cosine over
  the sandbox `.knowledge-semantic/text-embedding-bge-m3.json` index
  (paths/vectors parallel arrays, 1024-dim). Planner D7's pinned-vectors
  idea was unnecessary: LM Studio :1234 IS reachable in tests — the 2d lane
  runs under `test:embed` (BENCH_EMBED=1), skip-guarded offline.
- Convergence: in-process `ingestRecords` over the sandbox vault (planner
  D2). The sandbox is seeded from the already-converged real vault, so run
  1 UPSERTS (`created: 0`) — the idempotence gate asserts `created: 0` on
  BOTH runs + stable updated counts.
- tsconfig: `moduleResolution: bundler` + DOM lib (bench imports transitive
  sibling sources; Node16 trips their extensionless imports — deviating
  from perf-harness's Node16 shape, documented in tsconfig comments).

## Tickets

- [x] `tickets/01-scaffold.md` — package + lib face + vault sandbox
      (checksum-guarded: real-vault graph dir fingerprinted before/after)
- [x] `tickets/02-fixtures-golden.md` — 13 PDFs committed (36 MB, planner
      D5); goldens authored by 3 glm-5.3 judge sessions from INDEPENDENT
      openPdf re-extraction (D9 anti-leak), schema-validated (≥8 answerable
      + ≥2 unanswerable, anchors in range); loadGolden filters non-numeric
      "numeric claims" (judge artifact)
- [x] `tickets/03-lane-structural.md` — 13 cards, 0 violations; anchor
      inheritance from section headers + meta-note exemptions; D4 artifact
      pins (no sibling-title tags, single H1)
- [x] `tickets/04-lane-extraction.md` — verbatim-preservation proxies on
      GMSBench (5 pp end-to-end conversion in tmp): number recall, span
      coverage, table-row survival ≥ thresholds. Fixed mid-ticket: the
      faithfulness criterion is VERBATIM substring (glued tokens like
      `3Ho` from `3Host` must be preserved as-is); boundary/standalone
      semantics live only in the vision gate ground.ts
- [x] `tickets/05-query-gates.md` — 2c tag recall@5 (measured 0.692 vs
      design 0.90 — recorded gap); 2d MRR (measured 0.153 vs design 0.70 —
      recorded gap) + bite check (post-removal MRR collapses); embed retry
      ×3 against transient LM Studio nulls
- [x] `tickets/06-live-lanes.md` — 1d faithfulness judge + planted fault,
      1b grounding summary, 1e exact-dup dedup; scorecard receipt
- [x] `tickets/07-gates-closeout.md` — gates + reviewer + merge + successor

## Decisions

Planner D1–D9 adopted: D1 2d primitive = retrieveRecords + embedQuery;
D2 in-process convergence (no bridge); D3 13 real vault cards as source of
truth (copied, never mutated); D4 scripts `check`/`typecheck`/`test` +
`test:embed` + `bench`; D5 commit all 13 PDFs (36 MB, no LFS); D6 live
subset = pinned 5 papers; D7 2d in the embed tier (LM Studio reachable —
pinned vectors unneeded); D8 CJK-slug collision = xfail (fix is ranked
next-goal #3); D9 goldens from independent openPdf extraction only.

Executor additions:

- D10: faithfulness lane measures VERBATIM preservation (plain substring);
  boundary/standalone-quantity semantics belong to the vision gate
  (ground.ts). The two criteria were conflated in the planner text.
- D11: structural lane inherits anchors from section headers (house
  convention "**主要結果（Table 3，第 6 頁）**") and exempts meta notes
  (grounding 註記 / file2md 轉換 / 修正記錄).
- D12: golden load filters non-numeric "numeric claims" (judge authoring
  artifact) instead of rejecting the file.

## Fog of war

- Known measured gaps (recorded, queued): tag recall 0.692 < 0.90; MRR
  0.153 < 0.70 — graph-note summary/tag quality is the lever, not the
  bench.
- No scanned/OCR paper in the corpus — isScanFigure arm still unmeasured.
- MRR vector count: the sandbox index embeds ALL vault notes (2364); paper
  notes are 13 of them — the bite check removes exactly those.

## Cross-effort links

Builds-on: `2026-09-09-file2md-kcard-pipeline` (the design being
implemented), `2026-09-09-file2md-kcard-scale` (ground.ts + the fixture
corpus). Shares-decision-with: archify deck-render D1 (skiplisted live
receipts, never CI-gated on models).

## Shipped-as

PR (branch bench-kcards): `bun-apps/bench-kcards/` —
- deterministic lanes green in plain `bun test` (11/11): 1c structural
  (13 cards, 0 violations, anchor inheritance + meta exemptions), 1a
  extraction proxies on a real end-to-end fixture conversion, T4
  convergence harness (in-process ingest, idempotence, orphan gate),
  golden schema gate (13 goldens), 2c tag recall + 2d MRR (embed tier,
  skip-guarded) with the bite check;
- BENCH_LIVE runner + first scorecard receipt
  (`receipts/scorecard-first-2026-09-10.json`): 1d faithfulness run with
  the PLANTED FAULT caught (judge flagged the historical ReCite
  misattribution), 1e exact-dup caught;
- knowledge-card lib face (`src/index.ts`) created additively;
- honestly recorded gaps (queued, not hidden): tag recall 0.692 < 0.90;
  MRR 0.153 < 0.70; 1d judge context = single anchored page (SPINE subset
  judged 0 — page-text resolution needs the full-paper context upgrade);
  2b zk_ask + 1e paraphrase tiers not exercised in run 1; no scanned
  corpus paper.

## Fog of war resolutions

- Sandbox seeding copies the CONVERGED real vault → first ingest run
  upserts (created 0, updated 13) — the idempotence gate asserts the
  SECOND run creates 0 and updates identically.
- Bun JSON.parse pitfall: promise-missing-await produced phantom
  "[object Promise]" parse errors — the goldens were always valid
  (loadGolden path uses sync readFileSync).
