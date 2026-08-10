# 03 — Agentic mutex design

type: prototype
blocked by: 02
status: open

## Question

What is the **precise design of the agentic mutex** that makes web and TUI turns mutually exclusive while leaving pure app-logic lock-free — acquisition, release, per-side "blocked" presentation, sibling-attribution, and failure modes (abort / crash / timeout)?

## Context

- Both frontends share one `AgentSession` (path A, per 02). Only one may drive the model at a time.
- **Lock scope**: acquired on any turn-injecting call (`pi.sendUserMessage(...)` / `prompt` / `steer` / `followUp`) from EITHER side; **NOT** acquired by pure app-logic (pipeline / generation / local UI ops).
- **Blocked presentation**: the TUI already has `ctx.ui.setWorkingVisible` / respects `isStreaming`; the web needs an equivalent disabled-send + spinner. Ideally the blocked side knows *why* (its own pending turn vs the sibling holding the lock).
- **Failure modes**: how is the lock released on `ctx.abort()`, on a crashed/errored turn, on a hung turn (timeout)? Likely tie release to `agent_settled` / `turn_end` + a watchdog, not just the call's promise.
- Relevant pi seams: `pi.on("agent_start"/"agent_end"/"agent_settled"/"turn_end")`, `ctx.isIdle()`, `ctx.abort()`. Note `queue_update` is NOT observable from an extension (ticket 01) — if queue state matters for the lock, that's a patch.

## What resolving looks like

A prototype of the lock primitive + the two-side presentation, with failure-mode handling specified and tested (abort-release, crash-release, timeout-release). Probably the riskiest piece — prototype early once 02 lands.
