# 03 — Fold batch settled surfaces into the CC vocabulary (G4)

## Done when
- formatSlotMeta / formatUsage (subagents-tool.ts) render the CC order
  `model · 34,283 tokens · 2m 13s · $X.XXX` (tokens separator'd + spelled,
  human duration, cost only when non-zero) via core-runtime fmtTokens +
  fmtDurationHuman.
- The settled batch header `subagents batch (…) — 2m 13s · 34,283 tokens · $…`
  likewise; LIVE surfaces (buildLiveTable, live k/N header) keep fmtElapsed
  seconds; renderBatchResult (model-facing text) unchanged.
- Tests that pinned the old `45.3s · 38211 tok` strings updated.

## Why
Closes the prior map's fog-of-war: a transcript showing both `subagent` and
`subagents` results displayed two duration/token vocabularies on one composer.
