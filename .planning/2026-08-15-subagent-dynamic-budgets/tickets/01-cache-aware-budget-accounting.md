# Ticket 01 — cache-aware budget accounting: guard counts real tokens (input+output), cache excluded

Status: in progress · resumed from the parked fog list (fog item #1: cacheRead
accounting policy) · 2026-08-25

## Why now (the ledger evidence, measured 2026-08-25)

The ≥100-post-merge-run re-measure gate (ADR-subagent-0005 §Decision 5) is
ARMED: 200 rolling-window runs, all newer than the last 2026-08-18 snapshot.
Fresh census (rolling 200):

- done 121 / turns 23 / budget 20 / timedout 14 / failed 22
- envelope-writer healthy (18/22 done, 0 turns/budget deaths)
- envelope-recon: 9/64 budget deaths — and their **real** usage
  (input+output) is 19k–49k, at or BELOW the done-recon real p90 (29.8k) and
  max (39.8k). Every death record carries 73–85% cacheRead of total
  (e.g. total=255k = input 46.9k + output 0.8k + cacheRead 207k).
- unknown cohort's 9 budget deaths: same shape (real 26k–92k, cache-dominated).

Verdict: the recon 120k ceiling kills NO starving run — it kills big-context
children whose fixed context is re-billed as cacheRead every API round. The
dispatch-recovery skill's own turn-1 mega-block pattern maximizes exactly
this. Meanwhile the turns-deaths (19/23) are probe dispatches pinned at
maxTurns 1–3 (schema-cost smoke family — by design) and the timedout are the
same probe family; no production seam regression (the unknown cohort is
2026-08-21..23 smoke-test residue, not an envelope-less consumer).

## Decision (this ticket)

`tokenBudget` enforcement switches to REAL tokens — `input + output` — with
cacheRead/cacheWrite excluded from the billable metric:

- Runaway protection is retained structurally: maxTurns + timeoutMs bound the
  child that loops re-reading a giant context; the grace ceiling (1.25×)
  applies on the real metric where per-round overshoot is naturally small.
- Fallback: when the stats surface carries no breakdown (test doubles, older
  surfaces), the guard uses `total` (status quo) — the guard is never
  disabled by missing fields.
- Ceilings keep their numbers (recon 120k / writer 400k / tier 500k–1.5M):
  on the real basis they sit comfortably above done-real p90s (recon 29.8k,
  writer 50.4k) and still catch true runaway output.
- Run records and the `AgentUsage` channel are UNCHANGED (full breakdown +
  total still persisted) — only the enforcement metric moves.
- `spendBudget` semantics untouched (cost≡0 on this stack).

Rejected alternatives (recorded in ADR-subagent-0009): counting cache 1:1
(status quo — the measured false-kill mechanism); a separate cacheBudget
knob (adds a third currency nobody asked for); discounting cache by a factor
(arbitrary constant, same knob in disguise).

## Scope

1. `s2-agent-core-runtime/src/agent-budget.ts`: export
   `billableTokens(stats)`; widen the stats input types
   (`tokens.input?/output?`) on `checkBudgetExhaustion`,
   `checkBudgetWarning`, `BudgetSessionSurface`; guard (incl. the grace
   ceiling check) compares billable, not total. Zero-import invariant kept.
2. Callers pass the breakdown through: `spawn-subagent.ts`
   `budgetWarningFor` (has full usage), `subagents-tool.ts` batch `acc`
   (accumulate input/output alongside total).
3. Tests: pin (a) cache-heavy usage under budget → no abort; (b) same total
   with no breakdown fields → falls back to total; (c) grace ceiling on the
   real metric; existing suites stay green via the fallback.
4. `ADR-subagent-0009` (amends 0005's accounting policy).
5. Map: fog item #1 resolved; decision recorded; runs-stats snapshot row.

## Done-when

- [ ] Guard compares real tokens; fallback pinned by test.
- [ ] s2-agent-core-runtime + s2-agent-ext-subagent canonical gates green.
- [ ] ADR-subagent-0009 written; map fog #1 closed with the measured numbers.
- [ ] Snapshot row appended (`runs-stats --snapshot --note`), PR merged CLEAN.
