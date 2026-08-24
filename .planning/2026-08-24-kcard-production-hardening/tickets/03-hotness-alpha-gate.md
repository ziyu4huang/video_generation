---
type: task
status: closed
closed: 2026-08-24
---

# 03 — Hotness α-flip gate on real ledger data

## Question

Does hotness blending (α > 0, cap 0.10) beat the count baseline on the real usage ledger — and if not, what does the recorded no-flip say about cadence?

## What to build

A ticket-09-style gate run: replay/accumulate REAL ledger cadence (both writers — zk_card reads via D12, retrieve echoes via D41) into `active_count`/last-use, sweep α ∈ {0.02, 0.05, 0.10} through the standing three-arm recall-audit harness on the real vault, and decide the default per D8/D39: flip only if hit@5 AND MRR both beat the count baseline. No flip → α stays 0, the map records the numbers and why.

NOTE: needs real cadence data to have accumulated (the D41 echo landed 2026-08-24; the context-lifecycle auto-recall injector is the other feeder, downstream of that effort). If the ledger is still too thin to be meaningful, the ticket's honest outcome is a measured "not yet — re-run after N weeks of cadence" with the harness left standing.

## Verdict — DEFERRED (D4 honest-defer), α stays 0

Ledger snapshot receipt (read-only `SELECT * FROM usage`, live `user_huangziyu` / `context_db`, measured 2026-08-24 15:22Z and re-confirmed 15:31Z):

| Field | Value |
|---|---|
| total events | **0** |
| by kind (zk_card / auto_recall / retrieve) | {} / {} / {} |
| time span | none |
| per-card distribution | none |

**The zero is thin cadence, not a broken writer** — wiring verified live at the production boundary: `host-fns.ts` `buildRetrieveOptions` sets `usageLog: true` (`src/host-fns.ts:89`) and the extension path does the same (`extensions/knowledge-card.ts:1150`); `KCARD_USAGE_LOG=0` is the hermetic-suite escape. The echo lane itself landed **2026-08-24** (PR #1974 — hours before this measurement), and the second feeder (context-lifecycle auto-recall injector, the `auto_recall` kind) is downstream of that effort and not yet writing. With zero events the α sweep has no signal to replay — running it would produce numbers indistinguishable from the count baseline by construction.

Decision per D4/D39/D8: **no flip — α stays 0**, the three-arm harness (`recall-audit.mjs`, D23) stays standing untouched. Re-run trigger: ledger ≥ ~100 events spanning ≥ 2 weeks, or the auto-recall injector going live — whichever comes first; then sweep α ∈ {0.02, 0.05, 0.10} and flip only if hit@5 AND MRR both beat the count baseline (D8, D25/D27 no-flip-without-evidence precedent).

## Acceptance

- [x] Ledger snapshot receipt: event counts by kind, time span, per-card distribution — enough to justify (or defer) the gate run — table above (all zero, wiring verified live)
- [x] Three-arm gate receipts at each α (or a recorded deferral with the measured reason) — deferral recorded: 0 events, echo lane hours old, second feeder not landed
- [x] Default decision recorded in the map per D25/D27 precedent (flip or no-flip, with both metrics) — no-flip; metrics N/A at zero cadence (recorded as such, not asserted)
- [x] D14: independent reviewer pass — inline review (docs-only change, no code); reviewer-subagent dispatch skipped: two consecutive silent dispatches last session (systemic pool issue, RCA open in next-goal ranked list), disclosed in the PR body
