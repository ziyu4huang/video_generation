---
type: research
status: open
blocked by: 01, 02
---

# 03 — Per-divergence rationale + consolidation strategy

## Question

For each of the 4 divergent runners (01 ①–④): WHY does it diverge, and what is
the consolidation strategy (consolidate to the unified path / retain with
rationale / hybrid)?

## What resolving it looks like

Per divergence, determine:

- **WHY divergent** — obsidian ① + tool-gate ② chose child-process subprocess
  (isolation? separate cwd? historical?); btw ③ + core-task ④ call
  `createAgentSession` directly (lower-level control? streaming? custom hooks?).
  Code-read + grill the author's intent.
- **CAN it move to the unified path** — given 02's contract ruling (does
  "unified" require in-process?). Subprocess→in-process may be infeasible if
  isolation is load-bearing → hybrid (subprocess wrapper that registers
  telemetry + resolves models via config).
- **Strategy per divergence** — consolidate / retain-with-rationale / hybrid.

This graduates per-divergence **build tickets** (the actual consolidation work)
once the strategy + contract are locked.

## blocked by

- 01 (the divergence list + gaps) — closed
- 02 (the contract + the in-process-vs-subprocess ruling)

## Fog this clears

- btw / core-task lower-level needs (what control bypassing the runner buys them).
- The subprocess-isolation question for obsidian / tool-gate.
