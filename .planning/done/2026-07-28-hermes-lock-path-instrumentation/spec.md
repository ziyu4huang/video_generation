# Spec — hermes lock-path instrumentation & first characterization

Effort: `2026-07-28-hermes-lock-path-instrumentation`
Stage: SYNTHESIZE (from the grilled map). Parent decisions: see `map.md` D1–D3.
Domain glossary: `bun-apps/pi-agent-ext-hermes-memory/CONTEXT.md`.

## Problem Statement

The hermes-memory perf recorder shipped in #908 makes the **read / index / sync**
lifecycle paths auto-visible: each is `timed()`, its Surreal HTTP round-trips are
attributed, and threshold breaches land in `perf.jsonl`. But the **write /
consolidation / cross-process file-lock path** — the exact place where the open
#853 (2-phase consolidation) and #854 (errorCapture throttle) issues live, where
a single overflow can hold the global `failures.md` lock for up to ~60 s while a
child agent runs a local LLM — is **not instrumented at all**. `_add` /
`_addInner` / `runConsolidator` / `withFileLock` carry no `timed()` wrap, and
`auto-consolidate.ts` has zero perf hooks.

Consequence: `perf.jsonl` does not exist anywhere (confirmed across all
worktrees + `~/.pi`) — so "no breaches" is *partly "not measured"*, not only
"not slow". We currently have **no data** to decide whether the #853 structural
fix or the #854 throttle is actually warranted; both issues are explicitly
deferred "until storms recur", yet we cannot see the storms. From the maintainer's
perspective: the one hot path with a known structural risk is a blind spot, and
the data-driven next step (D1) is blocked on having no data from that path.

## Solution

Extend #908's breach-only perf architecture to cover the lock path it misses, in
two complementary instrumentations, then close the loop in the same iteration
with a **controlled, deterministic characterization test** that produces the
first real records off the newly-instrumented path — without waiting passively
for a real multi-session storm.

1. **Lock-hold timing (breach-only, zero-noise — consistent with #908).** Time
   the cross-process file-lock *hold* span (lock acquired → release) in
   `withFileLock`. Normal holds are single-digit-ms file I/O; an
   **Auto-consolidation** hold runs up to ~60 s. A lock-specific wall-clock
   threshold (default ~5 s, tunable) makes any long hold — the thing that
   blocks other sessions into `ELOCKED` — auto-visible in `perf.jsonl`, with
   the TUI notifier already wired by #908.

2. **Consolidation event (always-logged — the deliberate exception to
   breach-only).** Auto-consolidation is the rare, high-signal event under
   study; *every* occurrence matters, not only slow ones. Record each
   consolidation with its target, wall-clock duration, and whether it timed out
   (terminated). This is the dataset that decides #853 / #854.

3. **Controlled load test.** A deterministic test that constructs a `MemoryStore`
   with a tiny **Failure** char limit (forces overflow fast), injects a mock
   consolidator that *sleeps* to simulate the LLM hold, injects a recorder with
   a low threshold + tmp `logPath`, and triggers an overflow write. It then
   asserts `perf.jsonl` captured both the consolidation event and (when the hold
   exceeds threshold) the lock-hold breach. This characterizes the hold-duration
   and timeout signal **without a real LLM or real Surreal**.

The deliverable is **observability + a first sample**, not a fix. The #853 / #854
fixes stay deferred until this data (plus passive real-session accumulation)
shows storms recurring.

## User Stories

1. As a hermes maintainer, I want the cross-process file-lock hold duration to
   be timed, so that any long hold is auto-recorded instead of invisible.
2. As a hermes maintainer, I want a long lock hold to breach into `perf.jsonl`
   on its own threshold (separate from the lifecycle 2 s / 50-round-trip one),
   so that consolidation-scale holds aren't drowned out or falsely grouped with
   cheap file writes.
3. As a hermes maintainer, I want the lock-hold breach to fire the existing TUI
   notifier, so I see "slow fileLock.hold.*" in-session just like lifecycle
   breaches, with no new notifier surface to maintain.
4. As a hermes maintainer, I want *every* Auto-consolidation run logged (not just
   slow ones), so I can characterize how often consolidation fires, for which
   target, how long it holds the lock, and whether it times out.
5. As a hermes maintainer, I want the consolidation record to distinguish a
   normal completion from a timeout/termination, so a silently-killed child
   (the 60 s cap) is visible as a distinct signal.
6. As a hermes maintainer, I want the lock-hold threshold to be tunable via an
   env var, so I can dial sensitivity per environment without code changes.
7. As a hermes maintainer, I want a deterministic test that reproduces a
   consolidation-triggered long hold without a real LLM, so the instrumentation
   is covered by CI and the first dataset is reproducible on demand.
8. As a hermes maintainer, I want that test to assert both the consolidation
   event and the lock-hold breach appear in `perf.jsonl`, so the two
   instrumentations are proven end-to-end through the real `MemoryStore` write
   path.
9. As a hermes maintainer, I want the consolidation event and lock breach to
   flow through the same `PerfRecord` shape as lifecycle records, so one parser
   / one log file / one notifier handles all three.
10. As a hermes maintainer, I want perf tracking to keep its "never throws into
    the instrumented path" guarantee on the lock path too, so adding
    instrumentation cannot change write/consolidation functional behavior.
11. As a hermes maintainer, I want the new instrumentation injected via the same
    optional-setter DI pattern as `setConsolidator`, so `MemoryStore` stays
    decoupled from the recorder in tests (default pass-through, no recorder =
    no-op).
12. As a hermes maintainer, I want round-trip attribution to remain a no-op on
    the lock path (it is file I/O, not Surreal HTTP; the consolidator's child
    process can't attribute back anyway), so records aren't misleadingly zeroed
    or mislabeled.
13. As a hermes maintainer reading `perf.jsonl`, I want each record to carry an
    op namespace that tells me which path it came from (`lifecycle.*` vs
    `fileLock.hold.*` vs `consolidation.*`), so I can slice the log by path.
14. As a hermes maintainer, I want the characterization test to be honest about
    what it measures — hold duration + timeout, *not* real cross-process
    `ELOCKED` counts — so nobody mistakes the synthetic sample for real
    contention data.
15. As a hermes maintainer, I want the spec to leave the #853 / #854 *fixes* out
    of scope, so this iteration stays a focused observability PR and the fixes
    remain gated on the data it produces.

## Implementation Decisions

- **DI seam — inject perf into `MemoryStore`.** Add a setter on `MemoryStore`
  parallel to the existing `setConsolidator` (e.g. `setPerfTimed(timed:
  TimedFn)`), defaulting to a pass-through `(op, fn) => fn()` so the store is
  fully usable in tests with no recorder. Wire it from the host (`index.ts`)
  for both the global `store` and the `projectStore`, right where `setConsolidator`
  is wired today. This reuses #908's existing `TimedFn` injectable contract — no
  new coupling type.

- **Lock-hold timing — breach-only.** Inside `withFileLock`, wrap the *held*
  span (from lock acquired to `release()`), not the acquire-retry/poll loop
  (that is wait time, not hold time). Op namespace `fileLock.hold.<target>`
  (`memory` | `user` | `failure`). Wall-clock `ms` is the only meaningful signal
  here — the critical section is local file I/O (`loadFromDisk` → mutate →
  `saveToDisk`), not Surreal HTTP, so `roundTrips` will read ~0 and the `ms`
  reason is expected. Threshold is **lock-specific and higher than the lifecycle
  2 000 ms**: default ~`5 000 ms`, tunable via `PI_HERMES_PERF_LOCK_MS` (and a
  recorder option), because normal holds are single-digit ms and a
  consolidation hold is tens of seconds — 5 s cleanly separates them.

- **Consolidation event — always-logged.** Inside `runConsolidator`, wrap the
  `this.consolidator(target, signal)` call with a recorder path that
  **persists every time** (not breach-gated), op namespace
  `consolidation.<target>`. Rationale: Auto-consolidation is rare (fires only
  on overflow) and is the exact phenomenon under study — every occurrence is
  signal, and breach-only would hide the fast-but-frequent case that matters
  for #854. This is the **single intentional divergence** from #908's
  breach-only / zero-steady-state-I/O philosophy, justified by rarity +
  study-intent; call it out in the recorder's module docstring.

- **Recorder interface extension — add an always-persist path.** #908's
  `PerfRecorder` only persists on breach or when `fullTrace` is recorder-wide
  on. Add a minimal per-call always-persist entry (e.g. `timedAlways(op, fn)`
  — same timing + notifier, but persists unconditionally) so the consolidation
  event doesn't require flipping a global `fullTrace` flag. Keep the existing
  `timed` / `setNotifier` / options untouched.

- **`PerfRecord` schema — backward-compatible optional fields.** Add optional
  fields to carry the consolidation specifics and a path-kind discriminator:
  `kind?: "lifecycle" | "fileLock" | "consolidation"` and
  `timedOut?: boolean` (the consolidator's terminated flag). All optional, so
  existing lifecycle records and the `perf.test.ts` suite are unaffected. The
  `consolidation.*` record sets `kind: "consolidation"`, `timedOut` from the
  child result, and `breach: false` by default (it is always-logged, not a
  breach) unless its `ms` also crosses the lock threshold.

- **Notifier reuse — no new surface.** Both the lock-hold breach and the
  consolidation event route through the existing `setNotifier` wiring in
  `index.ts` (TUI). A consolidation event may notify at info-level rather than
  warn-level (it is expected, not a breach) — decide the level in the build
  ticket, but do not add a second notifier channel.

- **Op-namespace convention.** Lifecycle ops keep their existing labels
  (`startup.*`, `shutdown.*`, `backfill.*`, `live-index.*`); new ops use
  `fileLock.hold.<target>` and `consolidation.<target>`. The optional `kind`
  field is the machine-sliceable discriminator; the op string stays
  human-readable.

- **Never-throws guarantee extended.** The lock-path wraps must preserve #908's
  "perf tracking must not change functional behavior" invariant: any
  timing/append/notify failure inside `withFileLock` or `runConsolidator` is
  swallowed; the write/consolidation result is returned exactly as before.

- **AsyncLocalStorage nesting note.** `timed` shadows the parent's round-trip
  counter when nested. On the lock path this is harmless: round-trips are
  irrelevant (file I/O / child process), and each `timed`/`timedAlways` measures
  its own `ms` independently. No change to the nesting design is needed; record
  the reasoning in the build ticket so it isn't "fixed" later.

- **Controlled load test — deterministic, mock-based.** Construct a
  `MemoryStore` with a tiny **Failure** char limit (via config) so an overflow
  is reached with minimal data; inject a mock consolidator (`setConsolidator`)
  that `sleep`s a controlled number of ms to simulate the LLM hold (and a
  variant that returns `terminated` to exercise `timedOut`); inject a recorder
  (`createPerfRecorder`) with a low `thresholdMs` + tmp `logPath` (mirroring
  `tests/perf.test.ts`'s `tmpLog` / `readLog` helpers); drive an overflow write;
  assert the log contains the `consolidation.failure` event and, when the mock
  hold exceeds threshold, the `fileLock.hold.failure` breach. No real LLM, no
  real Surreal, no real multi-process concurrency — fast and reproducible.

- **Honest scope of the sample.** The test characterizes *hold duration + timeout
  frequency* — the core #853 signal. It does **not** measure real cross-process
  `ELOCKED` counts or real contention across live sessions; that data still
  accumulates passively from real usage once the instrumentation ships. State
  this limitation in the test's docstring so the synthetic sample is never
  mistaken for real contention telemetry.

## Testing Decisions

- **Highest seam, ideally one.** The single external-behavior seam is
  `createPerfRecorder` + the `MemoryStore` write path with an injected mock
  consolidator — the same seam `tests/perf.test.ts` already exercises for the
  recorder. Prefer extending that pattern over adding a new test harness.

- **What good tests assert here (behavior, not implementation):**
  - A consolidation that holds the lock for ≥ threshold produces a
    `fileLock.hold.<target>` record with `breach: true`, `reason: "ms"`.
  - Every consolidation produces a `consolidation.<target>` record (always-logged),
    with `kind: "consolidation"` and `timedOut` reflecting the child result.
  - A non-overflowing write produces **no** lock-path records (breach-only holds
    its zero-noise promise; consolidation doesn't fire).
  - Timing/append failure inside the lock path does not alter the write/consolidation
    result (never-throws invariant).
  - The new `PerfRecord` optional fields default such that existing lifecycle
    records and the current `perf.test.ts` suite still pass unchanged.

- **Prior art.** `tests/perf.test.ts` — `tmpLog` / `readLog` helpers,
  overridable `thresholdMs` / `thresholdRoundTrips` / `logPath` / `fullTrace`,
  `setNotifier` breach collection, `bumpRoundTrips` no-op check. Mirror these.

- **Modules under test.** `src/perf.ts` (the `timedAlways` addition + optional
  fields) and `src/store/memory-store.ts` (the instrumented `withFileLock` /
  `runConsolidator` + the `setPerfTimed` setter). The host wiring
  (`src/index.ts`) is covered by the existing extension-contract/integration
  suite, not a new test.

- **Run command.** `( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`.

## Out of Scope

- **The #853 structural 2-phase-consolidation fix** — stays deferred until this
  data plus passive real-session accumulation shows storms recurring.
- **The #854 `errorCapture` throttle fix** — preventive, not yet data-warranted.
- **Real cross-process contention telemetry** (multi-session `ELOCKED` counts,
  acquire-wait time distribution) — requires live multi-session data; the
  synthetic test only characterizes hold duration + timeout. (Could be a later
  effort if passive data proves insufficient.)
- **Re-optimizing the already-clean lifecycle paths** — no breaches recorded;
  leave them alone.
- **Measuring the consolidator child's own internals** (its Surreal round-trips,
  LLM tokens) — the child is a separate process; attribution can't cross. Only
  the parent's wall-clock view is captured.
- **Changing the consolidation trigger policy or the 40 k char limit (#851).**

## Further Notes

- **Map cross-ref.** This spec resolves the four "Not yet specified" execution
  details from `map.md`: span = `withFileLock` hold + `runConsolidator` event;
  threshold = lock-specific ~5 s via `PI_HERMES_PERF_LOCK_MS`; load test =
  deterministic mock-based characterization (not a committed real-storm script);
  notifier = reuse #908's wiring.
- **D3 refinement (honesty).** The map's "force failures.md past 40 k +
  concurrent writers" is refined here to "tiny char limit + mock consolidator
  sleep" — same signal (hold duration + timeout), deterministic and CI-able,
  without ~40 k of fixture data or flaky multi-process concurrency. The
  concurrent-writers dimension is explicitly deferred to passive real-session
  data (see Out of Scope).
- **#908 philosophy preservation.** Breach-only + zero-steady-state I/O holds
  everywhere *except* the consolidation event, which is always-logged by
  design (rarity + study-intent). This single exception is documented in the
  recorder module docstring so the philosophy drift is intentional and visible.
- **Natural next step.** `to-tickets` — slice this spec into tracer-bullet
  tickets (likely: T1 recorder `timedAlways` + optional fields; T2
  `setPerfTimed` DI + lock-hold timing; T3 consolidation event; T4 controlled
  load test), then into the plan coordinator's execution substrate.
