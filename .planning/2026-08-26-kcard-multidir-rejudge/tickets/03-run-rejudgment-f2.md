# 03 — Run the re-judgment (recursive vs flat vs generic ×2) + F2 knob adjudication

Status: closed · Blocks: 04 · Blocked by: 02 · Closed: 2026-08-26 (reviewer APPROVE after REQUEST_CHANGES round — findings F1-F3 verified + addressed in-record; follow-ups in #2064)

## What

The D9 re-judgment on the multi-dir corpus: same 4-arm discipline as
2026-08-25 (recursive / flat-resource / generic-card baseline ×2 identical
runs, bge-m3 @ LM Studio, throwaway ns), plus the F2 per-knob verdicts
(`DIRECTORY_DOMINANCE_RATIO`, `GLOBAL_SEARCH_TOPK`, `RetrieverMode`) per map
D3. The t03 α-re-identification (0.3/0.5/0.7 sweep) and the L0/L1-vs-L2-only
ablation ride along — both were "re-open only with the multi-dir corpus".

## How

1. Confirm LM Studio bge-m3 up (canonical embedding, per CLAUDE.md).
2. Run resource-eval ×2 runs on the family corpus; save both receipts under
   `output/resource-eval/` (scratch) with numbers recorded here.
3. Split metrics: directory-discriminating vs within-doc questions (the
   battery's classes) — the recursive lane's advantage, if any, lives in the
   first split.
4. F2: for each knob, PORT (trivial env-gated sweep moved the metric) /
   KEEP-UNPORTED (no effect on this corpus, or effect not worth the surface).
   Implementation only if trivial; the verdict is the deliverable.
5. Independent reviewer subagent on the receipts before the verdict is
   recorded (watchdog OFF per CLAUDE.md dispatch rules).

## Done when

- [x] Both runs' receipts exist; determinism check across runs recorded
- [x] Per-class metrics table (dir-discriminating vs within-doc) in this
      ticket for all arms
- [x] F2 verdict per knob with evidence line
- [x] α sweep + L0/L1 ablation numbers recorded (ride-along fog items)
- [x] Reviewer pass receipt; map `last` touched

## Receipts (2026-08-26, live bge-m3 @ LM Studio :1234 + SurrealDB :8000)

- Main 4-arm × 2 runs: `output/resource-eval/multidir-rejudge-20260826.txt`
  + `output/resource-eval/receipt-2026-08-26T13-13-20-819Z.json`
- α sweep (recursive arm, 1 run each): `output/resource-eval/alpha-030.txt`,
  `output/resource-eval/alpha-070.txt`
- Corpus: `vlm-out/usb4-family` (1263 L2 pages / 41 dirs); battery
  `.planning/2026-08-26-kcard-multidir-rejudge/eval/questions.json`
  (26 graded = 16 dir-discriminating + 10 within-main-spec, + 2 negatives);
  resource index 1431 rows (1263 L2 + L0/L1 tiers).

## Headline numbers (identical across both runs — determinism `identical:true` all arms)

| arm | hit@1 | hit@3 | hit@5 | MRR |
|---|---|---|---|---|
| resource-recursive (α=0.5) | 4/26 | 8/26 | 11/26 | 0.253 |
| **resource-flat** | **8/26** | **12/26** | **14/26** | **0.394** |
| generic-hier | 4/26 | 6/26 | 6/26 | 0.192 |
| generic-flat-vector | 4/26 | 6/26 | 6/26 | 0.192 |

**The recursive lane still loses to flat on the multi-dir corpus** —
including the dir-discriminating split that was its entire theoretical
advantage. The D9 re-open condition did NOT move (numbers for the t04
verdict).

## Per-class split (run 1; run 2 identical)

| arm | dir-discriminating hit@5 / MRR (n=16) | within-main-spec hit@5 / MRR (n=10) |
|---|---|---|
| resource-recursive | 7/16 · 0.234 | 4/10 · 0.283 |
| resource-flat | **9/16 · 0.400** | 5/10 · 0.383 |
| generic-hier | 0/16 · 0.000 | 6/10 · 0.500 |
| generic-flat-vector | 0/16 · 0.000 | 6/10 · 0.500 |

**Generic-arm caveat (structural, not a retrieval verdict):** the generic
adapter ids are `generic:<basename>` — across a multi-dir corpus every doc's
`page-NNN` collides, so the 1263 adapted pages collapse to 839 vault files
(receipt: `card rows: leaves=839`). The 0/16 dir-discriminating score is a
COVERAGE artifact (companion pages were overwritten before indexing), not a
retrieval measurement. Reviewer recomputation: 15/16 dir-discriminating
targets' page content was overwritten (12 by main-spec pages, 3 by a v2-ecn
doc), 10/10 within-doc targets survive — the within-doc split (6/10,
MRR 0.500, best of any arm) shows the card lane is fine where ids are
unique. **Note (reviewer F3):** t02 (#2063) ALREADY attempted per-doc id
namespacing in `resource-eval.mjs` (~line 275), but `docSlug` resolves to
the literal `"pages"` for every file (`rel.slice(0, rel.lastIndexOf("/"))
.split("/").pop()` = the segment before the basename, which is always
`pages`), so every id became `generic:page-NNN@pages` — a buggy no-op, and
the file's comments falsely claim stems are namespaced per doc dir. Fix =
one line (take the DOC dir segment, not `pages`) + correct the comment;
follow-up issue filed. Also: `genericMatch` matches basename-only as-run, so
the matcher does not discriminate docs on this corpus (no false hit
occurred, but the record must not imply it did).

## F2 knob verdicts (per map D3; adjudicated from measured runs + upstream audit §E)

- **`DIRECTORY_DOMINANCE_RATIO` — KEEP-UNPORTED.** Evidence: on the corpus
  where directory shaping could finally matter (41 dirs, 16 dir-discriminating
  questions), the recursive lane UNDERPERFORMS plain KNN (7/16 vs 9/16,
  MRR 0.234 vs 0.400). A dominance-shaping factor tunes a mechanism that is
  not load-bearing; there is no measured deficit for it to fix.
- **`GLOBAL_SEARCH_TOPK` — KEEP-UNPORTED.** Evidence: the port already has
  the analogous constant (`childLimit = max(limit*2, 20)` in
  resource-recursive.ts); the recursive lane's deficit is wrong-directory
  descent (hit@1 4 vs flat 8), which child-search width does not address.
- **`RetrieverMode` (THINKING/QUICK) — KEEP-UNPORTED.** Evidence: parity D19
  deterministic posture (no reranker/intent/model stages; caller passes
  filters). No measured scenario needs a second search mode; the gap to flat
  is structural, not a mode/latency trade-off.

## Ride-along fog items

*(α attributions corrected after the reviewer pass — the receipts self-record
`meta.alpha` at run start and are authoritative; the first recording of this
table had 0.3 and 0.7 swapped.)*

- **α re-identification (resource-tier t03/t04 fog): RESOLVED.** Multi-dir
  breaks single-dir α-invariance, but mildly: α=0.3 → 13/26 · 0.278 (best),
  α=0.5 → 11/26 · 0.253, α=0.7 → 11/26 · 0.251. Best α (0.3) still loses to
  flat (14/26 · 0.394). Default holds at 0.5 (no adoption case for change;
  the 0.3-vs-0.5 delta is 2 hits on 26 questions).
- **L0/L1-vs-L2-only ablation (flat lane): INCONCLUSIVE at K=5 (corrected
  after the reviewer pass — the first recording used a wrong tier-row
  detector: tier sidecar uris ARE .md paths, `.overview.md`/`.abstract.md`).**
  `resourceKnnQuery` does not filter level. With the correct detector:
  4/26 queries have tier rows in the flat arm's top-5 (6 slots total), and
  ALL 4 are misses; two of them (gen4-link-recovery, clx-exit ECN questions)
  have tier rows occupying 2/5 slots inside the CORRECT directory with the
  target page absent from top-5 — crowding is plausible and cannot be
  excluded from K=5 receipts. A deeper-topK rerun (or an L2-filtered flat
  run) is the follow-up; single-dir D9 measured −0.024 MRR from tier-row
  presence, direction-consistent with crowding.

## Reviewer pass

**REQUEST_CHANGES → addressed.** Independent reviewer subagent recomputed
every number from the raw receipts: headline table, per-class split,
determinism (strengthened to full perQuery deep-compare, identical), and the
collision mechanism all VERIFIED. Three findings, all confirmed by my own
re-verification and corrected in this record:

1. α sweep attributions were swapped (receipts authoritative: best is
   α=0.3, not 0.7) — table corrected.
2. The L0/L1 ablation claim used a wrong tier-row detector (`.md`-suffix
   check misses `.overview.md`/`.abstract.md`); real count is 4/26 top-5s
   with tier rows, all misses — downgraded RESOLVED → INCONCLUSIVE at K=5.
3. The generic-arm caveat proposed "namespaced ids" as a follow-up, but t02
   already shipped namespacing — with a `docSlug` bug making it a no-op
   (`"pages"` for every file) — caveat amended; fix filed as an issue.

The three KEEP-UNPORTED knob verdicts were checked and stand unchanged.

## Second measurement (2026-08-26 parallel session — fixed baseline, full index; reconciles #2064)

A parallel session in the `video_generation__subagent` worktree ran the same
4-arm eval AFTER the docSlug fix and on the complete 1433-row index — its
receipts supersede the generic-arm and index-dependent cells above (this
record's run raced the tier-sidecar writes: 1431 vs 1433 rows, and its
generic arms still carried the id collision):

- Receipts: `output/resource-eval/receipt-2026-08-26T13-16-57-978Z.json`
  (main 4-arm × 2, byte-identical runs), `…13-19-40-711Z` (α=0.3),
  `…13-20-15-545Z` (α=0.7), `ablation-flat-l2only-2026-08-26.json`
  (L2-filtered flat). Numbers recorded here (the receipts are scratch):
- **Generic arms now VALID** (leaves=1263, ids namespaced by doc dir):
  generic-hier 17/26·0.449 (dir-split 12/16·0.449 — best of any arm),
  generic-flat-vector 15/26·0.406. The 0/16 above was indeed the collision
  artifact; the card lane is genuinely strong on multi-dir.
- **Recursive vs flat unchanged in direction**: recursive 10/26·0.215 vs
  flat 14/26·0.394 (this record's 11/26·0.253 reflects the 2-row index
  race); dir-split 7/16·0.234 vs 9/16·0.400; α=0.5 = 10/26 here vs 11/26
  above (same race). α=0.3 (13/26·0.278) and α=0.7 (11/26·0.251) reproduce
  EXACTLY across both runs — the verdict is race-invariant.
- **#2064 part 1 (docSlug)**: fixed in the reconciling PR (namespace by the
  path minus its trailing `pages` segment; immediate-parent namespacing is
  a no-op). Part 2 (crowding): the L2-FILTERED flat run this record asked
  for measured 15/26·0.401 vs 14/26·0.394 all-rows — tier rows cost the
  flat lane ~1 slot; crowding is real but small. Both parts discharged.
- That session's own reviewer pass confirmed its receipts raw; its three
  corrections (citation of the console-only `reproduction` block; the
  α=0.3 dir-class hit@5 TIE at 9/16; persisting the ablation) are folded
  into the numbers above.
