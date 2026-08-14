---
status: done
---

# Subagent efficiency guardrails

## Goal
Cut subagent-run token waste and failure rate by adding DEFAULT guardrails
(token/spend budgets, commit-scope, impossible-tool pre-flight) plus a
dispatch-discipline skill. Today these knobs exist but are opt-in / unset, so
unbounded runs blow past sane limits.

## Why now (evidence — run-history analysis 2026-08-09, ~/.pi/subagents/runs)
- Failure mix: 0 hard failures, 3 timeouts, 15 budget-exhausted runs.
  Budget exhaustion is the DOMINANT failure mode.
- Token blowups: 130k–3.4M tokens/run. Examples:
  - 17-line seam fix (#1155 impl) → 1.34M tok (run mslouix3)
  - "write 2 memory entries" → 927k tok / 5.7 min (run mslovsnn) — impossible-task
    over-engineering: subagent lacked the `memory` tool, reverse-engineered the
    hermes store bootstrap + wrote+ran a temp script instead of failing fast.
  - gate-recall task → 3.4M tok (run mslns1vl)
- `git add -A` disregard: the #1155 implementer staged a 38-file sweep despite
  explicit prohibition (caught by commitScope, never merged — but recurring).
- Re-verification loops: detached-HEAD re-checks burn turns.
- Budgets WORK when set (run msl3c9zi aborted cleanly at a 380k cap) — they are
  just rarely set, because there is NO default.

## Non-goals (already solved — do NOT duplicate)
- Per-provider concurrency cap → effort 2026-08-07-...-paralel-run (#1062).
- Active-tool-set threading + tool-gate seeding → effort 2026-08-08-fix-subagent-spawn-seam (#1127/#1129).

## Tickets
- 01 default-budget-guardrails — done (#1280)
- 02 commit-scope-default — done (#1278)
- 03 impossible-tool-preflight — done (#1277)
- 04 retry-loop-detector — done (#1279)
- 05 dispatch-discipline-skill — done (#1158)

## Knob locations (for implementers)
- tokenBudget/spendBudget params: bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts:181 ; consumed agent.ts:373-375,609
- commitScope: subagent-tool.ts:182 ; guard: bun-apps/pi-agent-ext-subagent/src/git-scope.ts
- DEFAULT_TIMEOUT_MS: subagent-tool.ts:78 (=15min)
- rate limiter: bun-apps/pi-agent-ext-subagent/src/rate-limiter.ts (__piRateLimitState)
