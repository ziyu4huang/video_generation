---
effort: 2026-09-06-self-arc-5
created: 2026-09-06
last: 2026-09-06
status: done
---

# Wayfinder map: 2026-09-06-self-arc-5 — swarm: multi-parallel children + concurrent receipt instances

## Destination

Raise the loop's parallelism proof from 2 children to 3 (true concurrency,
big model) and stress the harness itself by running MULTIPLE receipt
instances concurrently — the user-directed "use subagent multiple parallel
to test" round.

## Shipped

- **`--scenario swarm`**: one parent prompt → the batch tool with EXACTLY
  three tasks, all `agentType: hard-problem` (glm-5.3). Checks: liveRow,
  `threeConcurrent` (batch header `k/3 running` reaching ≥2 mid-flight, or ≥3
  distinct live Task rows), `allSettled` (three per-child `✓ done` rows or
  the batch header `3 ok · 0 failed · 0 skipped — Ns`), `childModelIsGlm53`.
- **Check-design lesson (latched in-loop):** the per-child ✓ done rows and
  the batch header scroll out of the viewport once the parent's reply lands —
  a final-screen-only check reads an already-scrolled display and
  false-fails. The settle evidence is now LATCHED inside the polling loop
  (same class of bug as the F-ui-2 stale-row and the parallel-round settle
  heuristics: always evaluate while the surface is showing).
- **Concurrent instance stress:** THREE tui-drive instances at once
  (dispatch + viewer-abort + agents) — all three receipts PASS
  (parallel-instance-a/b/c). The loop runs fine under concurrent pty + GLM
  load.

## Receipts

`output/self-arc5-receipt-2026-09-06/`: swarm source PASS, swarm deployed
(`0.10.0+g7735878`) PASS, parallel instances a/b/c PASS.

## Queue (next)

- Fix F-ui-2 (stale aborted entry in the Running section) — the UI side of
  self-arc-4's finding (`subagent-viewer.ts`).
- Pack-definition visibility in /agents (packDirs is empty in the dialog).
