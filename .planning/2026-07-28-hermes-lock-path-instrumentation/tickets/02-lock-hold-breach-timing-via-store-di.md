---
type: task
blocking: 01
status: closed
---

# 02 — Lock-hold breach timing via store DI

## Question

Make the cross-process file-lock **hold** duration observable end-to-end:
inject the recorder into `MemoryStore` and time the held span in `withFileLock`,
breach-only at a lock-specific threshold — the core instrumentation that turns
the #853 / #854 blind spot into a measured path.

## What to build

`MemoryStore` gains an optional perf setter **parallel to the existing
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

## Acceptance

- [ ] A `MemoryStore` write with no recorder injected behaves exactly as today
      (pass-through default; all existing `memory-store` tests pass).
- [ ] A write whose held span exceeds the lock threshold produces a
      `fileLock.hold.<target>` record with `breach: true`, `reason: "ms"`,
      `kind: "fileLock"`.
- [ ] A normal fast write produces **no** lock-path record (breach-only /
      zero-noise holds its promise).
- [ ] The lock threshold is tunable via `PI_HERMES_PERF_LOCK_MS` (and a recorder
      option), default ~`5 000 ms`.
- [ ] The host wires the recorder into **both** the global store and the
      `projectStore`.
- [ ] A perf-timing / append / notify failure inside `withFileLock` does not
      alter the write result (never-throws).
- [ ] AsyncLocalStorage nesting is accounted for and documented (the parent's
      round-trip counter is shadowed by a nested `timed`, but round-trips are
      irrelevant on this file-I/O path and `ms` is measured independently per
      call — no correctness impact).

## Resolution (closed 2026-07-28)

Implemented in `src/perf.ts` (timed opts `{thresholdMs, kind}`), `src/store/memory-store.ts` (`setPerfTimed` DI + withFileLock held-span wrap as `fileLock.hold.<target>`, env `PI_HERMES_PERF_LOCK_MS` default 5000), `src/index.ts` (wired into both stores). Commit ccc33bc0. Breach-only: fast writes log nothing. 5 TDD cases in `tests/store/lock-hold-perf.test.ts`. Review: SPEC ✅ + QUALITY approved.
