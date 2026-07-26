---
type: grilling
status: open
---

# 02 — Define the "strong unified dispatch" contract

## Question

What exactly must a subagent dispatch do/have to count as "unified + strong"?
This is the bar every divergent runner (01's ①–④) is measured against +
consolidated toward.

## What resolving it looks like

A grilling session (one question at a time) that pins:

- **Runner-path**: must the dispatch call `spawnSubagent` / `WorkflowAgent` (the
  in-process runner)? Or does a subprocess wrapper that still registers
  telemetry + resolves models via config count as "unified"? — the hard question
  for obsidian ① + tool-gate ②, which run pi as a child process (possibly for
  isolation).
- **Model-resolution**: must resolve via `tiers` / `capabilities` config (no
  hardcoded ids) — the no-hardcode principle.
- **Error/retry/timeout**: must inherit `retryOnTransient` + `timeoutMs`
  defaults (or explicitly opt out with rationale).
- **Telemetry**: must register in the in-flight registry + run-persistence
  (visible to `/subagents`).

The output is a one-paragraph contract + the **in-process-vs-subprocess ruling**
that 03's per-divergence strategy depends on.

## blocked by

(none — runs in parallel with 01, which is already closed)
