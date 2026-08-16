---
type: grilling
status: closed
---

## Question

Which items from the `2026-08-15-subagent-dynamic-budgets` map enter this effort's spec scope? Its destination (self-calibrating p90 token/time budgets replacing the frozen tier table), its 4 closed decisions, and its 8 fog items are on the table. Decide: which fog items become tickets here (recalibration cadence + persistence format, cacheRead accounting policy, role granularity beyond recon/writer, report-edge headroom reservation, all-or-nothing envelope mixing, time env knobs, grace-ceiling ratio, batch soft-gate extension to time); write the CONVENTIONS.md-mandated `## Cross-effort links` block on BOTH maps (`Shares-decision-with:`); settle the old effort's disposition (absorbed → its map status becomes `paused` with a pointer here, or closed-superseded).

## Resolution

Decided (human grilling 2026-08-16):
- Disposition: the 2026-08-15-subagent-dynamic-budgets map becomes **paused** — front-matter `status: paused` + `last: 2026-08-16`, plus a `## Cross-effort links` section: `Shares-decision-with: 2026-08-16-optimize-planning-pipeline-aka-extension — its dispatch-cost destination is absorbed into that effort's spec; this map is revivable as its own effort.` Its 4 closed decisions (p90 self-calibration replacing the frozen tier table; symmetric timeBudget with tier defaults + 80% warning + two-stage wrap-up; turnsUsed persisted on ALL runs; spendBudget never-defaulted) are CITED, not re-decided.
- Spec scope: this effort's spec cites those 4 decisions and settles 2 fog items itself: (1) report-edge headroom reservation (the #1 observed dispatch death pattern), (2) recalibration cadence + persistence format (where the recalibrated table lives; interaction with env overrides). The other 6 fog items stay fog on the paused map.
