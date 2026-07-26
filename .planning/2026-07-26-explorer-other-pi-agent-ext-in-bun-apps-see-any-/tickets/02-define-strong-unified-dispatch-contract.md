---
type: grilling
status: closed (2026-07-26) — contract locked
---

# 02 — Define the "strong unified dispatch" contract

## Resolution — the contract

A subagent dispatch is **unified + strong** iff it provides all four guarantees.
The mechanism (in-process vs subprocess) is secondary to the guarantees —
process isolation is accommodated, not outlawed.

**§1 Runner-path — guarantees-based, mechanism secondary.** In-process dispatch
MUST go through `spawnSubagent` / `WorkflowAgent`. Subprocess dispatch (a child
pi process) is permitted ONLY via a **shared wrapper** that provides §2–§4.
`btw` + `core-task` (direct `createAgentSession`) move to in-process
`spawnSubagent`. `obsidian` + `tool-gate` (subprocess) go through the shared
subprocess-wrapper (their isolation is load-bearing).

**§2 Model-resolution — config-only, no hardcodes.** Resolve via
`tiers` / `capabilities` config; no hardcoded model ids in any code. Subprocess
dispatch delegates to pi's own config-reading (the spawned pi reads
`~/.pi/workflows/model-tiers.json`) — auto-satisfied, no injection needed.

**§3 Error/retry/timeout — required for all (default-on).** Every dispatch
inherits `retryOnTransient` (default true) + a default `timeoutMs`. For
subprocess dispatch, the shared wrapper imposes retry + timeout around the
child process. Opt-out requires explicit, documented rationale.

**§4 Telemetry — required for all (visible).** Every dispatch registers in the
in-flight registry + run-persistence (visible to `/subagents`). For subprocess
dispatch, the shared wrapper registers a host-side **phantom entry**
(start → done) tracking the child — granular inner activity is best-effort, but
the run is observable.

### The in-process-vs-subprocess ruling (keystone)

"Unified" = same **guarantees**, not same mechanism. Subprocess isolation is
legitimate (tool-gate L2 QA needs a clean process; obsidian distill/garden
benefits from crash isolation) — it is accommodated via the shared subprocess-
wrapper (which injects config-awareness + imposes retry/timeout + registers a
phantom telemetry entry). `btw` + `core-task` have no such isolation need →
they consolidate to plain in-process `spawnSubagent`.

## What this unblocks

03 (per-divergence strategy) — the contract is the bar; 03 now decides each
divergence's path to meeting it, and graduates the per-divergence **build
tickets** — incl. the **shared subprocess-wrapper** as its own build ticket
(the §1 vehicle for obsidian + tool-gate).
