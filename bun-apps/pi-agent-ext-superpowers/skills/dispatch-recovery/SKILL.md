---
name: dispatch-recovery
description: Use when a dispatched subagent dies at its tokenBudget or maxTurns, or before redispatching after any child death — recovery decisions, not pre-dispatch planning. Janitor-first recovery, verify-by-git trust rules, verbatim-apply redispatch briefs.
---

# Dispatch recovery

Child death at budget is routine (~17% of dispatches in the reference census: 166 done / 20 turns-capped / 14 budget-dead). Plan every multi-step mission for it; never treat a death as an exception.

## Trust rules (verify-by-git)

A dying child's last words are not evidence. Dying children report progress optimistically ("src changes DONE") that the tree contradicts — recorded incidents show two consecutive "done" claims with zero code on disk.

- Before ANY recovery action: `git status --short`, `git diff --stat`, `git log --oneline -5`.
- Budget-dead children still commit completed work — the log tells you what actually landed.
- Redispatch only what the tree proves missing.

## Recovery recipe (janitor-first)

Do not redispatch the original mission. Dispatch a janitor child:
1. status — what is staged/committed vs missing
2. run the task's gates
3. commit green work found in the tree
4. report: what landed, what remains

Janitor recovery is cheap (small budget, 4-6 turns) and recovered nearly every recorded death.

## Redispatch shape (verbatim-apply)

Design-in-child dispatches die mid-design. The surviving shape:
- The parent does the research and authors the EXACT file content / command sequence.
- The child receives a verbatim apply brief (heredoc content, exact commands, exact commit message).
- Every turn starts with one mega-block (all reads in turn 1), never exploratory drip-reads.

## Ledger

Record every dispatch outcome on the SDD ledger line (see executing-plans "Dispatch ledger"): task, tokenBudget, maxTurns, done|died|janitored, commit SHA. Run records do not persist tokenUsage — the orchestrator's ledger is the only cost record.

## Rationalization table

| Dying-child claim | Reality check |
| --- | --- |
| "src changes DONE" | git diff shows nothing |
| "tests green, committing next" | no commit; re-run the gates yourself |
| "fixing X, almost there" | died at turn cap; partial work in tree — the janitor decides keep/discard |

## Provenance

> Provenance: goal 5464ff67 session chain (PRs #1574-#1626); run-record census 2026-08-18 (200 records); candidate `.planning/knowledge/subagent-dispatch-empirics.md` (consumed on promotion).
