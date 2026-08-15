> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Wayfinder map: 2026-07-28-hermes-lock-path-instrumentation

## Destination

Turn the hermes-memory **consolidation / file-lock write path** from
*unobservable* into *observable + first-sampled*, so the next decision on the
open #853 / #854 lock-contention issues becomes **data-driven** instead of
speculative. This is the **perf-tracker-driven next iteration**: it extends
#908's breach-only perf architecture to the one hot path that release
currently does **not** cover — the `_add` / `_addInner` / `runConsolidator` /
`withFileLock` span where the 60 s cross-process lock holds live — then closes
the loop in one iteration with a **controlled load test** that forces a
consolidation storm and reads the first real breach data off the newly
instrumented path. **Planning note:** this effort SHIPS observability + a
characterization sample; it deliberately does NOT ship the #853 / #854 fixes —
those wait for the data this produces.

## Notes

- **Scope origin**: 2026-07-28 grill (wayfind DECIDE stage). Three decisions
  resolved one-question-at-a-time (see *Decisions so far*).
- **Domain**: hermes-memory observability. Skills every session should consult:
  `grilling` (done), `to-spec` / `to-tickets` (next, SYNTHESIZE), then
  `test-driven-development` (for the controlled load test) +
  `systematic-debugging` (when reading the breach data).
- **Key facts gathered from the environment (not guesses)** — the decisive ones
  that shaped the decisions:
  - #908's perf recorder default log path =
    `~/.pi/agent/pi-hermes-memory/perf.jsonl`; it **does NOT exist** anywhere
    (every worktree + `~/.pi` + `~/.pi/agent`) → **no breach has been recorded
    since #908 landed**.
  - `perf.timed()` **IS** wired into the read / index / sync hot paths:
    `startup.syncMarkdownMemories`, `shutdown.indexSession`,
    `backfill.needsBackfill`, `backfill.indexChangedSessions`,
    `live-index.indexSession`; every Surreal HTTP round-trip calls
    `bumpRoundTrips()`. → those paths are measured and (apparently) clean.
  - **COVERAGE GAP (the crux)**: `_add` / `_addInner` / `runConsolidator` /
    `withFileLock` in `store/memory-store.ts` are **NOT** wrapped by `timed()`,
    and `handlers/auto-consolidate.ts` has **zero** perf instrumentation. → the
    #853 / #854 60 s lock-hold path is **invisible** to the tracker. "No
    breach" is therefore partly *"not measured"*, not only *"not slow"*.
  - #908 thresholds: `2000 ms` wall-clock, `50` HTTP round-trips (the N+1
    signal), breach-only by default, full-trace via `PI_HERMES_PERF=1`.
  - Related open issues: **#853** (2-phase consolidation — move the LLM step
    out of the file lock; the issue body self-marks *"recommend deferring until
    storms recur"*), **#854** (throttle `errorCapture` — `failures.md` fills
    faster than consolidation keeps up). #851 raised
    `DEFAULT_FAILURE_CHAR_LIMIT` 20 k → 40 k (the mitigation that bought the
    current headroom).
- **Convention**: conversational language 繁體中文; all written artifacts
  English. Project decisions live here in `.planning/` (wayfinder), **not** the
  `memory` tool.
- **Shell / venv discipline** (from CLAUDE.md): invoke the pipeline via
  `python/venv/bin/python` from the repo root; never top-level `cd`; tests via
  `( cd bun-apps/<pkg> && bun test )`.

## Decisions so far

- **D1 — Iteration direction = hermes perf-tracker driven.** Stay in
  hermes-memory; let #908's breach recorder point at the next bottleneck rather
  than guessing the next N+1. (Resolved 2026-07-28 grill, confirmed.)
- **D2 — First concrete move = instrument the lock path.** Wrap
  `_add` / `_addInner` / `runConsolidator` / `withFileLock`
  (`store/memory-store.ts`) with `perf.timed()` + a wall-clock breach
  threshold, so #853 / #854's 60 s lock holds become observable. This fills the
  exact blind spot the data-driven analysis just exposed (the measured paths
  are clean; the risky path is unmeasured). (Confirmed.)
- **D3 — Deliverable shape = instrument + controlled load test.** Ship the
  instrumentation **and** a controlled load test that forces `failures.md` past
  the 40 k limit under concurrent writers, to read the first breach data off
  the newly-instrumented path **within this iteration** — closing the
  data-driven loop instead of ship-and-wait for a real storm. (Confirmed.)

## Not yet specified

- **Which span to wrap.** Lean: the `withFileLock` critical section (single
  wrap point, uniformly covers add / replace / remove / transfer /
  consolidation holds) **plus** a dedicated consolidation-fired event (target +
  duration + timed-out flag). Confirm in the spec/ticket.
- **Lock-path threshold value.** Wall-clock only (normal holds <1 s,
  consolidation up to 60 s) — a ~`5000 ms` breach threshold is proposed.
  Round-trip attribution is **meaningless** for the consolidator's child
  sub-agent (separate process; AsyncLocalStorage doesn't cross), so the lock
  op relies on the `ms` reason, not `roundTrips`.
- **Load-test disposition.** One-off sampling script vs. committed
  characterization / regression test; and its home (`app/tests/` vs. a
  `scripts/` path). Defer to the build ticket.
- **Notifier surface.** Reuse #908's existing breach-notifier wiring
  (`index.ts`) or add a lock-specific notifier. Defer to the build ticket.

## Out of scope

- **The #853 structural 2-phase-consolidation fix** — deferred until the data
  this effort produces shows storms recurring (consistent with #853's own
  "defer" note). Re-open / bump priority if the load test or real usage
  breaches the lock threshold.
- **The #854 `errorCapture` throttle fix** — preventive, not yet
  data-warranted; revisit after this effort's characterization sample is read.
- **Re-optimizing the already-clean read / index / sync paths** — no breaches
  recorded; leave them alone unless full-trace surfaces a near-threshold op.
- **Non-hermes areas** — subagent TUI (#831), other extensions, upstream
  fidelity catch-up. Different destinations.
