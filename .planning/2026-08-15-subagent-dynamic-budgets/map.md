---
effort: 2026-08-15-subagent-dynamic-budgets
created: 2026-08-15
last: 2026-08-16
status: paused
---

# Wayfinder map: 2026-08-15-subagent-dynamic-budgets

## Destination

Subagent budgets become self-calibrating and symmetric across tokens/turns/time — rolling p90 auto-recalibration from `~/.pi/subagents/runs` (tier×role buckets) replaces the frozen 2026-08-09 tier table; new `timeBudget` gains full parity with `tokenBudget` (tier defaults + 80% advisory warning + two-stage wrap-up grace); `timeoutMs` degrades to a backward-compat alias.

## Notes

- Current defaults frozen: `TIERED_TOKEN_BUDGET_DEFAULTS` small=500k/medium=1.2M/big=1.5M (p90 of 200 done runs, calibrated 2026-08-09); `ROLE_AWARE_DISPATCH_BOUNDS` recon 60k/8turns/5min, writer 400k/24/20min, all-or-nothing envelope (any explicit bound opts out whole).
- No elapsed-time budget exists: wall-clock = one-shot `timeoutMs` hard abort only (15min in-process default / 5min subprocess — divergent magic numbers); no warning, no grace, not persisted in `SubagentBudgetDetails`.
- Real usage (200 runs, 2026-08-15): done 140 (median 71k tok/87s), turns-aborts 31 (median 506k/281s), budget-aborts 23 (median 339k/352s), timedout 6 (median 958k/1223s); cost≡0 every run; `turnsUsed` persisted only on turns-aborts; cacheRead billed 1:1 dominates (96-97% of grace overshoot); budget deaths cluster at report-edge (1.21M/1.23M/1.5M ≈ ceilings).
- Philosophy arc documented in `.planning/specs/2026-08-15-subagent-budget-hardening.md` + `.planning/knowledge/subagent-dispatch-budget-protocol.md` (warn-only advisories never abort; protocol: no explicit budget below tier defaults — prose, unenforced).

## Decisions so far

- Symmetric three-currency: `timeBudget` gets tier defaults + 80% warning + two-stage wrap-up (grace turn before hard stop); `timeoutMs` stays as alias for compat.
- Dynamic base: rolling p90 auto-calibration from the runs DB (tier×role buckets), written back to the defaults table at startup/periodically; env knobs keep override precedence.
- Persist `turnsUsed` on ALL runs (today only turns-aborts record it) — calibration needs the feedback data.
- `spendBudget` stays never-defaulted (cost≡0 on this stack).

## Not yet specified

- cacheRead accounting policy (count 1:1 vs exclude vs separate cacheBudget)
- Role-model granularity beyond binary recon/writer
- All-or-nothing envelope mixing semantics
- Env knob extension to time (`SUBAGENT_TIME_BUDGET_*`)
- Grace ceiling ratio for time
- Batch soft-gate extension to time

## Out of scope

- spendBudget defaults
- Workflow-tool budget changes
- Rate-limiter/concurrency
- Display-layer work (effort `2026-08-15-subagent-tui-display`)

## Cross-effort links

Shares-decision-with: 2026-08-16-optimize-planning-pipeline-aka-extension — its dispatch-cost destination is absorbed into that effort's spec (which cites this map's 4 closed decisions and settles report-edge headroom + recalibration cadence). Revivable as its own effort; the 6 remaining Not-yet-specified items stay here.
