# Blind eval — compact CC-style (arm B) vs built-in (arm A)

Status: OPEN (follow-up #2 of PR #1787). Started 2026-08-22.

## Question

Arm B (CC-style 9-section summary) produces 1.5–2.2× longer summaries than arm A
(host built-in). Do the extra tokens buy enough recall/fidelity to keep arm B as
the shipped default? Answer needs blind scoring accumulated over ≥5 sessions
(this cannot be closed in a single session — later sessions append to the table
below).

## Material

- `blind-eval/batch-<N>/<NN>-pair.md` — one per session: deterministic fact set
  (ground-truth paths / user requests / error strings) + the two summaries as
  anonymous **Summary X** / **Summary Y**, coin-flipped. No metrics in the pair
  file: arm B is consistently longer, so lengths would de-anonymize.
- `blind-eval/batch-<N>/key.json` — `xArm` per pair (+ token counts); open ONLY
  after all pairs in the batch are scored.
- `ab-report.json` — full summaries + metrics (cost side, not blind).

Regenerate a batch (model = medium tier; `--out` resolves against the package cwd,
pass ABS paths):

```bash
bun run --cwd bun-apps/s2-agent-ext-compact ab --n 5 \
  --out <repo>/.planning/s2-agent-compact-cc-style/ab-report.json \
  --blind-dir <repo>/.planning/s2-agent-compact-cc-style/blind-eval/batch-<N>
```

Note: a failed run (e.g. provider 429) overwrites `--out` with an empty-results
report — `git checkout` it back before retrying.

## Scoring rubric

Per pair, score X and Y **independently**, 0/1/2 each criterion (max 10 per
summary). Judge from the pair file only.

| # | Criterion | 0 | 1 | 2 |
|---|---|---|---|---|
| 1 | Path recall | none of factSet paths | some | most/all, none invented |
| 2 | User-request recall | gist lost | partial | every request's intent captured |
| 3 | Error/fix recall | errors absent | mentioned w/o resolution | errors + fixes both present |
| 4 | Identifier fidelity | identifiers rewritten or paths invented | minor paraphrase | exact identifiers; no "Done" without evidence |
| 5 | Continuation utility | can't resume | partial | current work + next step explicit enough to resume cold |

## Procedure (blind discipline)

1. Score **all** pairs in a batch BEFORE opening `key.json`. Record scores keyed
   by `pair + X/Y`.
2. Per pair, ALSO record a forced choice: "which summary would I resume work
   from — X or Y?" (no tie allowed). Batch 1 showed 10/10 score saturation; the
   forced choice is the tiebreaker and primary signal.
3. De-blind, then append rows to the results table.
4. Verdict per pair: winner = forced choice; rubric totals explain WHY.

## Decision rule (after ≥5 sessions accumulated)

Keep arm B as default if it wins-or-ties ≥70% of pairs AND mean of criteria 1–3
(recall) favors B. If B wins recall but loses utility, tune
`COMPACT_MAX_TOKENS_FACTOR` before reconsidering the default. If B loses recall,
that is hallucination pressure → the deferred verify/repair loop
(`docs/UPSTREAM-LESSONS.md`) becomes the data-backed follow-up.

## Results

| Batch | Pair | Session (short) | X total (arm) | Y total (arm) | Winner | Notes |
|---|---|---|---|---|---|---|
| 1 | 01 | ltx 2026-07-10 | A: 10 | B: 10 | tie | both fully resumable |
| 1 | 02 | pi 2026-07-05 | B: 10 | A: 10 | tie | |
| 1 | 03 | pi 2026-07-10 | A: 9 | B: 10 | **B** | A recalled ~half the factSet paths; B near-all |
| 1 | 04 | deploy 2026-07-18 | A: 10 | B: 10 | tie | |
| 1 | 05 | memory 2026-07-13 | B: 10 | A: 10 | tie | B has stray `</summary>` artifact at EOF (cosmetic) |

Batch 1 (2026-08-22, judge: Claude glm-5.3 in-session, all pairs scored before
de-blinding): **B wins-or-ties 5/5, 0 losses, 1 strict win.** Recall criteria
(1–3) favor B (pair 03 path recall). Score saturation (four 10/10 ties) means
the rubric discriminates poorly at the top — future batches should add a
forced-choice question ("which summary would you resume from — X or Y, no tie
allowed") to break saturation.

### Cost side (from report, not blind)

| Batch | Mean A tokens | Mean B tokens | B/A | Mean A compression | Mean B compression |
|---|---|---|---|---|---|
| prior (2026-08-22 03:35, previews only — same 5 sessions) | 1613 | 3139 | 1.95 | 15.9 | 14.8 |
| 1 (2026-08-22 08:11) | 1631 | 3410 | 2.09 | 15.9 | 14.5 |

### Interim read

Arm B default is supported so far (no losses; the only observed failure mode of
arm A — path-recall drop on a file-heavy session — is exactly what the
`<verified-files>` hint targets). Not yet closing: single judge, single batch,
saturated scores. Close after at least one more batch (ideally a different
judge/session) with the forced-choice tiebreaker added.
