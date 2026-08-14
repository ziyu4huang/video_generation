# Plan — subagent budget hardening (3 tasks, TDD, one squash-PR each)

Verification per task (use each package's canonical scripts from its package.json —
if `typecheck` does not exist use `check`; always finish with full `bun test`):
` ( cd bun-apps/pi-agent-ext-core-runtime && bun run typecheck && bun test ) `
` ( cd bun-apps/pi-agent-ext-subagent && bun run typecheck && bun test ) `
Merge: PR + local CI + `gh ship` (squash). Never wait on remote CI.

## T1 — core-runtime: onUsage mid-turn abort + direct unit tests

Files:
- `src/agent.ts`: extract budget evaluation so both seams call one function; add the
  usage-observation hook (same stats source as onUsage, `getSessionStats()`); on
  exhaustion → `session.abort()` + set `budgetExhausted` (idempotent guard; subscribe
  path remains as backstop). Update the three doc comments that say "may overshoot by
  up to one turn" (L370-374, L601-607, schema desc is T3's file) to describe sub-turn
  overshoot.
- `tests/agent-budget.test.ts` (new): direct `checkBudgetExhaustion` semantics —
  total == limit → allowed; total > limit → exhausted; spend path; tokens precedence;
  no budgets → undefined. Wiring: mid-turn usage above budget → abort fires before
  turn boundary; backstop path still aborts when usage seam never fires.

## T2 — 80% warning on three planes

Files:
- `pi-agent-ext-core-runtime`: expose final usage/budget-warning from the run so the
  parent-visible result can carry it (follow the existing result plumbing; do not
  invent a new channel if one exists).
- `pi-agent-ext-subagent/src/spawn-subagent.ts`: when a budget was set and final usage
  ≥ 80% of it (tokens or spend, whichever is bounded), attach warning to the result.
- `src/subagent-tool-render.ts`: `⚠` warn badge + result line, distinct from `⛔`.
- `src/subagent-run-persistence.ts`: persist `details.budget.warning`.
- Tests: spawn-subagent (warning attached at ≥80%, absent below, absent without
  budget; does not abort); render (badge/line); persistence (field round-trip);
  subagent-tool (details surface).

## T3 — maxTurns param (depends on T1's agent.ts changes)

Files:
- `pi-agent-ext-subagent/src/subagent-tool-schema.ts`: `maxTurns` (integer ≥ 1,
  optional, no default); description: turn-count governor, fixed-overhead driver
  (~10k+ tokens/turn), evidence summary, hard-abort + retried-once semantics.
- `src/subagent-tool-run.ts` + `src/subagents-tool.ts`: pass-through per child
  (singular + plural), no defaulting.
- `src/spawn-subagent.ts`: forward; classification mirrors the timeout path
  (transient, retried once under retryOnTransient), distinct message
  "max turns exceeded (N)".
- `pi-agent-ext-core-runtime`: count agent turns; abort before starting turn
  maxTurns+1.
- `src/subagent-tool-render.ts` / `subagent-run-persistence.ts`: status/record
  follows the timeout pattern.
- Tests: schema-weight (new param present); tool forwarding (singular + plural);
  classification + retry-once; core-runtime turn counting; render/persistence.
