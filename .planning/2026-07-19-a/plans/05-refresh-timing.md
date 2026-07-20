---
tracer-bullet: 5
part: a
ticket: 09
status: done
depends on: [02]
---

# 05a — Refresh-timing refinement (gate tool_execution_end to mutating tools)

## Why

TB2 wired `refreshPlan(latestCwd)` on **every** `tool_execution_end`. That re-parses the plan dir after read-only tools too (read/grep/ls/find/todo) — wasteful. TB5(a) gates it to the tools that can actually edit a plan file.

## Change

`coordinator.ts` — pure `shouldRefreshAfterTool(toolName)`: `true` for `{write, edit, bash}` (the file-mutating tools; `bash` covers sed/redirect/tee), `false` otherwise. The plan lives in `.planning/<effort>/plans/*.md` or `docs/superpowers/plans/` — edited via write/edit/bash, never by read-only tools.

`extensions/core-task.ts` — `tool_execution_end` handler now: `if (latestCwd && shouldRefreshAfterTool(event.toolName)) refreshPlan(latestCwd)`. session_start remains the authoritative full refresh; this is the incremental re-parse after a possible edit.

## Verification

- `coordinator.test.ts`: +2 tests (write/edit/bash → true; read/grep/ls/find/todo/memory/web_search → false).
- full `pi-agent-ext-core-task` suite: **304 pass** (was 302), 0 fail.
- `tsc --noEmit` exit 0; `biome check` on touched files clean (core-task has no biome CI gate, but verified).

## Deferred (TB5b / ticket 04)

The "yield to `__piGoalActive`/`__piWayfindGrill`" half of TB5 is **underspecified** — no plan-context-injection exists to gate (only publish + gate + seed). It is the open **ticket 04** (sync timing & lifecycle) design question, best resolved via grilling with the implementation in hand (which now exists). session_start refresh + seed are already correctly scoped (seed fires only when the todo is empty, before any goal is active).
