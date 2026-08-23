# Implementation Plan — seeded from wayfind tickets

**Goal:** _(Seeded from wayfind tickets — sharpen into a one-sentence end state.)_

### Task 1 — [01-recorder-always-persist-and-discriminator-fields] 01 — Recorder: always-persist path + optional discriminator fields
> The recorder gains a per-call **always-persist** entry (`timedAlways(op, fn)`)
— same timing + notifier as `timed`, but it persists a record and notifies on
**every** call, not only on a threshold breach. This is the one mechanism the
consolidation event (T3) needs to log a rare-but-expected occurrence without
gate-keeping it behind a threshold or forcing `fullTrace` recorder-wide.

The `PerfRecord` shape gains two **backward-compatible OPTIONAL** fields:

- `kind?: "lifecycle" | "fileLock" | "consolidation"` — the machine-sliceable
  path discriminator (lifecycle = the existing #908 ops; the op string stays
  human-readable).
- `timedOut?: boolean` — carries the consolidator child's terminated flag (T3).

Existing `timed` semantics, the breach-only default, and the `fullTrace` flag
are **unchanged**. This slice adds **no store coupling** — its end-to-end proof
is the recorder test seam (`tests/perf.test.ts`): a caller can call
`timedAlways`, observe an unconditional record + notification, and set the new
optional fields.
- [x] `timedAlways(op, fn)` persists a record on **every** call (even when both
- [x] `timedAlways` fires the notifier on every call (not only on breach).
- [x] `PerfRecord` accepts optional `kind` and `timedOut`; setting them
- [x] Existing `timed` semantics unchanged: a non-breaching op with `fullTrace`
- [x] The existing `tests/perf.test.ts` suite passes unchanged (no behavioral
- [x] The never-throws invariant is preserved on the always-persist path

### Task 2 — [02-lock-hold-breach-timing-via-store-di] 02 — Lock-hold breach timing via store DI
> `MemoryStore` gains an optional perf setter **parallel to the existing
`setConsolidator`** (e.g. `setPerfTimed(timed: TimedFn)`), defaulting to a
pass-through `(op, fn) => fn()` so the store is fully usable in tests with no
recorder injected (mirrors the handlers' existing `timed?` injectable contract).

The `withFileLock` **held span** — from lock acquired to `release()`, NOT the
acquire-retry / poll loop (that is wait time, not hold time) — is wrapped at a
**lock-specific wall-clock threshold** (~`5 000 ms`, default; tunable via
`PI_HERMES_PERF_LOCK_MS` and a recorder option). Op namespace
`fileLock.hold.<target>` (`memory` | `user` | `failure`), `kind: "fileLock"`.

On this path round-trip attribution is expected to read ~0 — the critical
section is local file I/O (`loadFromDisk` → mutate → `saveToDisk`), not Surreal
HTTP — so `ms` is the only meaningful signal and the `ms` breach reason is
expected. The host wires the recorder into **both** the global `store` and the
`projectStore`, at the same place `setConsolidator` is wired today.

Breach-only: a normal fast write logs nothing; a hold over the threshold
breaches into `perf.jsonl` and fires the existing TUI notifier (wired by #908).
Normal write / consolidation functional behavior is unchanged — the
never-throws invariant is preserved (a timing / append / notify failure inside
`withFileLock` cannot alter the write result).
- [x] A `MemoryStore` write with no recorder injected behaves exactly as today
- [x] A write whose held span exceeds the lock threshold produces a
- [x] A normal fast write produces **no** lock-path record (breach-only /
- [x] The lock threshold is tunable via `PI_HERMES_PERF_LOCK_MS` (and a recorder
- [x] The host wires the recorder into **both** the global store and the
- [x] A perf-timing / append / notify failure inside `withFileLock` does not
- [x] AsyncLocalStorage nesting is accounted for and documented (the parent's

### Task 3 — [03-consolidation-always-logged-event] 03 — Consolidation always-logged event
> `runConsolidator` wraps the `this.consolidator(target, signal)` call with
`timedAlways` (from T1), op namespace `consolidation.<target>`,
`kind: "consolidation"`, and stamps `timedOut` from the child result's
terminated flag. **Every** consolidation is logged — the deliberate, documented
exception to #908's breach-only philosophy: Auto-consolidation is rare (fires
only on char-limit overflow) and is the exact phenomenon under study, so every
occurrence is signal, and breach-only would hide the fast-but-frequent case
that matters for #854.

The record flows through the **existing** notifier (wired by #908) — at
info-level rather than warn, since a consolidation event is expected, not a
breach (decide + document the level in this ticket; do not add a second
notifier channel). Because the consolidator runs in a **child process**, only
the parent's wall-clock `ms` is meaningful; round-trips read ~0 and that is
expected (attribution can't cross processes).

A consolidation whose hold also crosses the lock threshold (T2) additionally
produces the `fileLock.hold.<target>` breach — both records appear. Normal
consolidation behavior is unchanged: the bypass env (`PI_MEMORY_FILE_LOCK`), the
single retry, and the vault-offload floor all behave exactly as today.
- [x] Every consolidation run produces a `consolidation.<target>` record
- [x] The record's `timedOut` is `true` when the child result indicates
- [x] `kind: "consolidation"` is stamped; op namespace is
- [x] A consolidation whose hold also crosses the lock threshold additionally
- [x] Consolidation functional behavior is unchanged (bypass env, single retry,
- [x] The notifier level for the consolidation event is decided + documented

### Task 4 — [04-controlled-characterization-sample] 04 — Controlled characterization sample
> A deterministic test that exercises the **real** overflow → consolidation →
lock-hold path through `MemoryStore._add`, without a real LLM, real Surreal, or
real multi-process concurrency:

- Construct a `MemoryStore` with a **tiny Failure char limit** (via config) so a
  char-limit overflow is reached with minimal fixture data.
- Inject a **mock consolidator** via `setConsolidator` that `sleep`s a controlled
  number of ms to simulate the LLM hold; include a variant that returns
  `terminated` to exercise `timedOut`.
- Inject a **recorder** (`createPerfRecorder`) with a low `thresholdMs` + a tmp
  `logPath`, mirroring `tests/perf.test.ts`'s `tmpLog` / `readLog` helpers.
- Drive a real overflow write through `_add` (the `failure` target).
- Assert `perf.jsonl` contains **both** the `consolidation.failure` event (T3)
  and, when the mock hold exceeds the lock threshold, the
  `fileLock.hold.failure` breach (T2).

The test's docstring states the **honest scope**: it characterizes *hold
duration + timeout frequency* (the core #853 signal) — it does **not** measure
real cross-process `ELOCKED` counts or real contention across live sessions,
which accumulate passively from real usage after the instrumentation ships. The
synthetic sample must never be mistaken for real contention telemetry.

This is the capstone: it proves T2 + T3 work together end-to-end through the
real write path and yields the first dataset the maintainer can read to decide
whether #853 / #854 need action.
- [x] Test triggers a real overflow → consolidation → lock-hold via `_add` with
- [x] `perf.jsonl` contains a `consolidation.failure` record after the run.
- [x] When the mock consolidator sleep exceeds the lock threshold, `perf.jsonl`
- [x] A variant with a terminating mock consolidator stamps `timedOut: true` on
- [x] The test is deterministic, fast, LLM-free, Surreal-free (no network /
- [x] The test docstring documents the honest scope (hold + timeout frequency;
