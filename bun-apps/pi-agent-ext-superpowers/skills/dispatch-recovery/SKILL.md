---
name: dispatch-recovery
description: Use when a dispatched subagent dies at its tokenBudget or maxTurns, before redispatching after any child death, or when rebalancing dispatch budgets (turns-aborts dominate the ledger, a role ceiling sits below the done-run median, an envelope-less spawn consumer appears) — recovery decisions and median-driven calibration, never hand tuning.
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

## Budget before dispatch (sizing rule)

Size every dispatch BEFORE sending: maxTurns >= task steps + 2 (each turn re-pays ~10k+ tokens of fixed overhead); tokenBudget by tier ceiling. Default authoring mode = verbatim-apply (parent authors content, child applies mechanically). Every dispatch starts with one mega-block — all reads in turn 1.

## Calibration (rebalance procedure)

From the 200-run ledger: turns is the top killer (31/200 aborts) vs tokens (23) vs timeout (6). Raise turn ceilings before token ceilings — a ceiling below the done-run median starves typical successful runs (old recon 60k ceiling vs done-median 71k). `ROLE_AWARE_DISPATCH_BOUNDS` applies ONLY at the subagent tool seam; bounds move from ledger medians, never intuition.

**Trigger when:** turns-aborts dominate the ledger; a role ceiling sits below the done-median for that role; an envelope-less `spawnSubagent`/`spawnSubagentSubprocess` consumer appears; a direct call site carries caps but no abort-safety footer (budget death there = unrecoverable).

**Procedure:**
1. Ledger medians: `bun scripts/runs-stats.ts` (pi-agent-ext-subagent; counts + per-status medians from `~/.pi/subagents/runs`; `--trend` trajectory, `--snapshot` append). Prioritize turns > tokens > time.
2. Consumer census: grep ALL spawn/tool consumers; disposition each as tool-seam (envelope applies) / direct-call (fix in 3) / subprocess-seam (wall-clock is the ONLY knob) / workflow-family (own budget closure — NO-GAP BY DESIGN, do not re-audit).
3. Direct sites: classify recon vs writer from the effective toolset; spread `roleAwareDefaults(role)` / `roleAwareDirectCall` so caps AND footer apply atomically.
4. Bounds only from medians: ceiling >= done-median; turns headroom to the turns-abort median; leave unindicted dimensions unchanged.
5. Test pins: budget-defaults table pins + footer-gate pins (`shouldInjectFooter` flips at maxTurns > 10 — pin both sides).
6. Ship + re-verify (devops local-ci + pr-finish); suites green at merged HEAD.

**Pitfalls:** ANY explicit tokenBudget/maxTurns/timeout opts the whole envelope out (audit call sites for accidental explicit values); subprocess seam has no token/turn fields; re-measure gate — wait >=100 post-merge runs before touching bounds again.

**Verify:** package suites green; grep audit zero uncapped `spawnSubagent(` callers outside the library.

## Ledger

Record every dispatch outcome on the SDD ledger line (see executing-plans "Dispatch ledger"): task, tokenBudget, maxTurns, done|died|janitored, commit SHA. Run records do not persist tokenUsage — the orchestrator's ledger is the only cost record.

## Rationalization table

| Dying-child claim | Reality check |
| --- | --- |
| "src changes DONE" | git diff shows nothing |
| "tests green, committing next" | no commit; re-run the gates yourself |
| "fixing X, almost there" | died at turn cap; partial work in tree — the janitor decides keep/discard |

## Provenance

> Provenance: goal 5464ff67 session chain (PRs #1574-#1626); run-record census 2026-08-18 (200 records); candidate `.planning/knowledge/subagent-dispatch-empirics.md` (consumed on promotion). Calibration section merged from dispatch-budget-rebalance (2026-08-18 rebalance session, PRs #1652-#1661; candidate `.planning/knowledge/dispatch-budget-rebalance.md`).
