---
type: task
status: open
blocking: 01, 02, 03
---

# 04 — closeout-rerun: the honest re-run receipt + series map reconciliation

## Question

Does the fixed instrument, run for real over all 26 packages, now measure
green-or-named-skip everywhere — and do the maps say so?

## What to build

Run the fixed `audit-ext-packages.js` for real (`samples/run.ts`,
`PI_MODEL=zai/glm-5.3`, `ZAI_API_KEY` sourced from `~/.zshrc`, bounded
7-wide batches per arc-17 D7) over all 26 packages: the closing receipt is
26/26 gates green or `absent`-or-`env-drift`-with-reason, with file2md and
hyperframes passing via their canonical scripts; any real red the re-run
surfaces is recorded as successor material, not absorbed (D2). Record
actuals (wall-clock, token spend, verdict table) in the receipt. Then the
docs close-out PR: `Shipped-as` + status flip on this map; the
cross-effort correction lines on BOTH maps (arc-17's "test-hygiene: 64
failing tests" disposition → superseded-by-this-map's-receipts per D2);
the retrospective addendum (lesson: an unverified instrument fabricated a
successor arc — the executor re-run caught it; append to the learnings log
per the tool-quirk gate); the sv-analyzer no-action disposition (D6); and
the successor next-goal file (strict v2, validated, LATEST re-pointed) whose
queue head is the maintenance-mode remainder (merge-chain MC tickets,
#2179, and whichever improvement-room items the re-run ranks). Redeploy
status confirmed per t02's D5 note.

## Acceptance

- [ ] Real audit re-run receipt: 26/26 packages, verdict table + actuals
      recorded; file2md + hyperframes green via canonical scripts
- [ ] Any real red → recorded successor material with a first step, none
      silently dropped
- [ ] Both maps reconciled (arc-17 disposition corrected, this map done) +
      retrospective addendum + learnings entry + D6 disposition recorded
- [ ] Successor next-goal written, validator exit 0, LATEST re-pointed
- [ ] Docs PR merged via the devops chain; redeploy status stated
