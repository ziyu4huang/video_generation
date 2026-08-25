**ID:** `ADR-subagent-0009` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: repo-root `CONTEXT-MAP.md`

# 0009 — Cache-aware budget accounting — tokenBudget enforces REAL tokens (input+output)

**Status:** accepted
**Date:** 2026-08-25
**Amends [ADR-subagent-0005](./0005-dispatch-budget-architecture.md) (the accounting policy; the two-layer envelope architecture is unchanged).**

**Plan:** `.planning/2026-08-15-subagent-dynamic-budgets/tickets/01-cache-aware-budget-accounting.md`

## Context

ADR-subagent-0005's guard compares cumulative `usage.total` against
`tokenBudget`, and `usage.total` bills cacheRead 1:1 — every API round re-bills
the whole fixed context. The 2026-08-18 ledger already flagged this ("cacheRead
billed 1:1 dominates — 96-97% of grace overshoot") but parked the policy
question (fog item: cacheRead accounting).

The 2026-08-25 re-measure (rolling-200 window, re-measure gate ARMED at 200
post-merge runs) settled it with data:

- 9 envelope-recon budget deaths, every record 73–85% cacheRead of total
  (e.g. total 255,157 = input 46,867 + output 802 + cacheRead 207,488).
- Those runs' **real** usage (input+output) was 19k–49k — at or BELOW the
  done-recon real p90 (29.8k) and max (39.8k). No starving run existed; the
  120k recon ceiling was executing children for the crime of having a large
  fixed context, while they did less real work than the median successful run.
- The dispatch-recovery skill's own turn-1 mega-block pattern (all reads in
  turn 1) maximizes cacheRead re-billing on subsequent rounds — the
  recommended shape was the most-killed shape.

## Decision

The `tokenBudget` enforcement metric is **real tokens: `input + output`**,
cacheRead/cacheWrite excluded (`billableTokens()` in
`s2-agent-core-runtime/src/agent-budget.ts`; exhaustion check, 80% warning,
grace-ceiling check, and the plural-tool batch gate all ride it).

- **Fallback:** a stats surface without the breakdown (test doubles, older
  surfaces) bills `total` — a missing field never disables the guard.
- **Runaway protection is structural, not metric-based:** a child looping
  re-reads of a giant context is bounded by `maxTurns` + `timeoutMs`, and the
  1.25× grace ceiling now applies on the real metric, where per-round
  overshoot is naturally small (one round adds only its own real tokens).
- **Ceiling numbers are unchanged** (recon 120k / writer 400k / tier
  500k–1.5M): on the real basis they sit comfortably above done-real p90s
  (recon 29.8k, writer 50.4k) and still catch true runaway output. They were
  calibrated cache-inclusive, so on the real basis they are looser —
  deliberately: their job is catching runaways, not starving.
- **Records unchanged:** run records and the `AgentUsage` channel still
  persist the full breakdown + inclusive total; only enforcement moved.

## Alternatives considered

- **Keep counting cache 1:1 (status quo).** Rejected on the measured
  false-kill evidence above — 14% of envelope-recon dispatches died with
  real usage below the done median.
- **A separate `cacheBudget` currency.** Rejected: a third knob nobody
  calibrates; the ledger shows no failure mode it would catch that turns +
  timeout do not.
- **Discount cacheRead by a factor (e.g. 0.1×).** Rejected: an arbitrary
  constant with the same knob in disguise; either cache matters for safety
  (then the existing turns/timeout bounds are the right instruments) or it
  does not (then exclude it).
- **Count non-cache tokens for the live-agent lifetime budget only** (the
  cc-parity-2 F2 shape: tier ceiling as lifetime bound). That case was
  resolved differently (tier ceiling, no role envelope) and is unaffected;
  this ADR covers the per-dispatch envelope + batch gate.

## Consequences

- Big-context recon children survive on merit of real work; the budget-death
  signal becomes meaningful again (a future "budget" death means real
  runaway output).
- The grace ceiling's one-round overshoot bound tightens on the real metric
  (a round adds ~its real output, not the re-billed context), so mid-grace
  hard aborts land closer to the 1.25× line.
- The runs ledger's `status: "budget"` population after this change is NOT
  comparable to before — budget-history snapshots note the regime change
  (`runs-stats --snapshot --note`).
- Re-calibration of ceilings on the real basis is a separate, data-gated
  step (the ≥100-run re-measure gate applies as always).
