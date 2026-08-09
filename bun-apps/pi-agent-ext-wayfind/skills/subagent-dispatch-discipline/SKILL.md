---
name: subagent-dispatch-discipline
description: Use when you are about to dispatch a subagent (subagents/subagent) or spawn a child task — run the pre-dispatch checklist so every dispatch is bounded, scoped, and tool-fit instead of blowing the token budget or looping on an impossible task.
---

# Subagent Dispatch Discipline

Subagent dispatch is the largest source of token waste in this stack. A pre-dispatch checklist makes every dispatch bounded, scoped, and tool-fit — so runs neither blow past budgets nor loop on impossible tasks.

## Why this exists

Run-history analysis (2026-08-09, ~30 subagent runs): **budget exhaustion is the dominant failure** — 15 of ~30 runs; per-run usage 130k–3.4M tokens. A 17-line fix cost 1.34M tokens; a "write 2 memory entries" task cost **927k tokens** (the subagent lacked the `memory` tool, so it reverse-engineered a 927k-token workaround instead of failing fast). The guardrail knobs (`tokenBudget`, `spendBudget`, `commitScope`) already **work when set** — the waste is dispatching **without** them.

## Pre-dispatch checklist

Run this every time before you dispatch.

1. **Budget — always set it.** Pass `tokenBudget` + `spendBudget`, calibrated to the task:
   - read-only research / inventory → 30k–60k
   - single SDD implementer slice → 80k–150k
   - big synthesis / multi-file → 150k–300k

   Raise above these only with a stated reason. The uncapped default is the bug, not the baseline.

2. **Scope — always set `commitScope`.** For any subagent that can commit (write/edit/bash), pass `commitScope` as the **exact paths** it may touch; pass `[]` for read-only. State the same exact paths in the task prose. Never ask a subagent to `git add` selectively on its own.

3. **Tool-fit — never delegate an impossible task.** Confirm every tool the task needs is in the subagent's allowlist. If it needs a tool the child lacks (e.g. `memory`, `skill_manage`), do it in the orchestrator, add the tool, or reshape the task. (This single rule would have saved 927k tokens on the durable-memory task.)

4. **Bound the task.** If it would plausibly exceed the tier budget, split into staged dispatches. One subagent = one bounded outcome.

5. **Pick the right tool.**
   - read-only parallel fan-out → `subagents` (plural)
   - one focused task with side effects → `subagent` (singular)
   - a trivial single write/call → do it in the orchestrator; don't spawn

6. **Tag the tier.** small (search/inventory) · medium (balanced) · big (synthesis/judgment).

## Anti-patterns

- Dispatching with no `tokenBudget`.
- `git add -A` / `git add .` inside a subagent.
- Delegating a task that needs a tool the child lacks.
- Re-verifying from a detached HEAD, or redundant confirmation loops.
- One giant task where bounded dispatches would do.

## Knob locations

Deeper code fixes live in effort `2026-08-09-subagent-efficiency-guardrails`:

- `tokenBudget` / `spendBudget` params — `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts`
- `commitScope` guard — `bun-apps/pi-agent-ext-subagent/src/git-scope.ts`
- `DEFAULT_TIMEOUT_MS` (15 min) — `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts`
