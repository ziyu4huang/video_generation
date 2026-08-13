# Subagent efficiency guardrails — spec

**Status:** Done — all tickets shipped (#1158, #1277, #1278, #1279, #1280)

## Problem
pi subagent runs waste enormous tokens and fail late. Analysis of the run
history (~30 recent runs) shows budget exhaustion (15 runs) and timeouts (3) as
the dominant failure modes, with per-run token usage of 130k–3.4M. The
guardrail knobs that would prevent this — tokenBudget, spendBudget, commitScope
— all EXIST in bun-apps/pi-agent-ext-subagent but are UNSET by default (opt-in
only). There is no impossible-tool pre-flight (so subagents attempt tasks
requiring tools they lack → over-engineering), no retry-loop detector, and the
subagent-driven-development skill is silent on budget/scope discipline.

## Goals
1. Sane DEFAULT token + spend budgets so unbounded runs can't blow past limits.
2. commitScope applied by default so `git add -A` sweeps are caught even when the dispatcher omits it.
3. Fail-fast when a task requires a tool absent from the subagent's allowlist.
4. Circuit-break repeated identical-failure retries.
5. A wayfind skill codifying dispatch discipline (the root cause is mostly dispatch-side).

## Design (per ticket; see tickets/ for detail)
- Default budgets must be TIER-CALIBRATED (a single number won't fit both
  read-only research and implementer runs) and DECIDED hard-abort vs soft-warn.
- commitScope default must decide hard-require vs warn-default.
- Preflight + loop-detector are additive, lower-risk.

## Evidence
See map.md "Why now". Key run ids: mslouix3 (1.34M, 17-line fix), mslovsnn
(927k, impossible-tool over-engineering), mslns1vl (3.4M), msl3c9zi (clean
budget abort at 380k — proof budgets work when set).

## Out of scope
Concurrency (done #1062), active-set threading (done #1127/#1129), stage-4
goalState sessionId isolation (deferred, separate effort).
