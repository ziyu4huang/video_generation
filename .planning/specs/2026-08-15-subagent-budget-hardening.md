# Subagent budget hardening

Status: approved (HITL 2026-08-15, 2 grilling rounds). Do not re-open decisions.

## Problem

Budget enforcement in `pi-agent-ext-core-runtime/src/agent.ts` fires only on session
state changes (turn boundaries): `checkBudgetExhaustion()` (~L341-352) is evaluated via
`session.subscribe` (~L608-625), so an in-flight turn may overshoot the ceiling by up to
one turn. Evidence (2026-08-14): each child turn re-pays ~10k+ fixed overhead
(system prompt + AGENTS.md + CLAUDE.md + tool schemas); turn count — not task size —
dominates cost. tokenBudget is an abort line, not a spend governor; open-ended children
died at 400k-540k. `checkBudgetExhaustion` has no direct unit test (covered only
indirectly via pi-agent-ext-subagent tests).

## Design (approved)

1. **onUsage mid-turn abort** — evaluate the same `checkBudgetExhaustion()` on every
   usage observation (per API response, cumulative stats from `session.getSessionStats()`,
   the same seam `onUsage` already uses). Abort mid-turn via `session.abort()`; the
   existing per-turn `session.subscribe` check stays as backstop. First firing wins;
   idempotent — no double-throw of `WorkflowError(TOKEN_BUDGET_EXHAUSTED)`.
   Overshoot shrinks from ~one turn to sub-turn.
2. **Direct unit tests** — `pi-agent-ext-core-runtime/tests`: threshold semantics
   (strict `>`, boundary equal-is-allowed; tokens checked before spend; undefined when
   no budget) + wiring (mid-turn usage above budget aborts before turn end).
3. **80% warning (fixed ratio 0.8, no config knob)** — computed at the same seams;
   informational only, never aborts. Surfaces on three planes:
   (a) subagent result `details.budget.warning`;
   (b) durable `subagent_runs` record (`subagent-run-persistence.ts`);
   (c) TUI render — `⚠ budget 80%`-style warn badge, distinct from `⛔ budget` death.
4. **maxTurns param** — opt-in, no default (parallel to tokenBudget). Counts agent
   turns (prompt → final response); exceeding the cap aborts with timeout-like
   semantics: transient, retried once under `retryOnTransient:true`. Threaded through
   schema (`subagent-tool-schema.ts`) → run options (`subagent-tool-run.ts`) →
   spawn/classify (`spawn-subagent.ts`) → core-runtime enforcement → render/persistence.
   Mirrored as a per-child param in the plural `subagents` tool. Schema description
   must state that turn count is the fixed-overhead cost driver (~10k+ tokens/turn,
   2026-08-14 evidence: 6-group split = 60-69k vs single-block = 13.5k).

## Non-goals

- spendBudget defaults (cost ≡ 0 on local MLX).
- Pre-turn cost estimation (deferred; only if measured overshoot still matters after (1)).
- Configurable warning ratio.

## Acceptance

- Local CI green for both packages (canonical scripts + full `bun test`).
- New tests red → green; schema-weight test still passes (schema-cost canary measures
  the registered subagent tool automatically).
