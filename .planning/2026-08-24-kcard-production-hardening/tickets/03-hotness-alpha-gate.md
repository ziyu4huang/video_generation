---
type: task
status: open
---

# 03 — Hotness α-flip gate on real ledger data

## Question

Does hotness blending (α > 0, cap 0.10) beat the count baseline on the real usage ledger — and if not, what does the recorded no-flip say about cadence?

## What to build

A ticket-09-style gate run: replay/accumulate REAL ledger cadence (both writers — zk_card reads via D12, retrieve echoes via D41) into `active_count`/last-use, sweep α ∈ {0.02, 0.05, 0.10} through the standing three-arm recall-audit harness on the real vault, and decide the default per D8/D39: flip only if hit@5 AND MRR both beat the count baseline. No flip → α stays 0, the map records the numbers and why.

NOTE: needs real cadence data to have accumulated (the D41 echo landed 2026-08-24; the context-lifecycle auto-recall injector is the other feeder, downstream of that effort). If the ledger is still too thin to be meaningful, the ticket's honest outcome is a measured "not yet — re-run after N weeks of cadence" with the harness left standing.

## Acceptance

- [ ] Ledger snapshot receipt: event counts by kind, time span, per-card distribution — enough to justify (or defer) the gate run
- [ ] Three-arm gate receipts at each α (or a recorded deferral with the measured reason)
- [ ] Default decision recorded in the map per D25/D27 precedent (flip or no-flip, with both metrics)
- [ ] D14: independent reviewer pass
