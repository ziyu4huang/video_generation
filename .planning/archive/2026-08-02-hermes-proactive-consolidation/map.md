---
effort: 2026-08-02-hermes-proactive-consolidation
created: 2026-08-03
last: 2026-08-03
status: complete
---

# Wayfinder map: 2026-08-02-hermes-proactive-consolidation

## Destination

Proactive consolidation — decay-marked candidates trigger consolidation BEFORE overflow (UPSP §1 "continuous metabolism", the slice #1b explicitly deferred)

## Notes

_(none)_

## Decisions so far

- **D1 — Trigger model = decay-pressure on writes.** On each add/sync, if the count of below-heat-floor entries exceeds a threshold, trigger a consolidation pass over the low-heat tail. No daemon; reuses the injected 2-phase consolidator; metabolizes on activity. (Replaces the deferred #1b "no proactive consolidation" scope.)
- **D2 — Candidate set = heat-floor prefilter + K cap.** Feed the consolidator only entries below a heat-floor, capped at K (bottom-K of the below-floor set). Bounds the prompt; only truly-decayed entries are candidates; the LLM still decides what to actually merge. Knobs: floor + K.
- **D3 — Rate limiting = cooldown + in-flight guard.** Min interval (cooldownMinutes) between proactive passes AND skip the trigger if a consolidation is already running. Bounds frequency + prevents overlapping 2-phase reconciles from racing.
- **D4 — Placement = store method + handler fires-after-write.** MemoryStore exposes `maybeProactiveConsolidate()` owning the pressure-check + cooldown + in-flight state (instance state — DB-free, uses only the injected heat provider + consolidator). The write handler calls it fire-and-forget after each add/sync. No write-path blocking; no recursion; respects the DB-free boundary.

## Not yet specified

<!-- none -->

## Out of scope

<!-- none -->
> Closed 2026-08-15: D1–D4 all decided AND shipped (auto-consolidate.ts, maybeProactiveConsolidate); done-in-practice.
