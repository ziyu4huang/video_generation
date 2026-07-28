---
type: task
status: closed
---

# 01 — Recorder: always-persist path + optional discriminator fields

## Question

Add an always-persist timing path and two backward-compatible optional
discriminator fields to #908's `PerfRecorder`, so the lock path can be
instrumented per-call without flipping a global `fullTrace` flag and the log
can be sliced by path — the foundation slice every later ticket builds on.

## What to build

The recorder gains a per-call **always-persist** entry (`timedAlways(op, fn)`)
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

## Acceptance

- [ ] `timedAlways(op, fn)` persists a record on **every** call (even when both
      ms and roundTrips are under threshold), with correct `ms` + the active
      backend label.
- [ ] `timedAlways` fires the notifier on every call (not only on breach).
- [ ] `PerfRecord` accepts optional `kind` and `timedOut`; setting them
      round-trips through `perf.jsonl` (parse the file, read them back).
- [ ] Existing `timed` semantics unchanged: a non-breaching op with `fullTrace`
      off still writes nothing.
- [ ] The existing `tests/perf.test.ts` suite passes unchanged (no behavioral
      regression); new cases cover `timedAlways` + the optional fields.
- [ ] The never-throws invariant is preserved on the always-persist path
      (append / notify failure is swallowed, never reaches the caller).

## Resolution (closed 2026-07-28)

Implemented in `src/perf.ts` (commit e957c97f). `PerfRecorder.timedAlways(op, fn, opts?)` persists + notifies on every call (breach:false); `opts.kind` stamps the discriminator, `opts.timedOutFrom(result)` derives timedOut (only on success). `PerfRecord` gained optional `kind`/`timedOut`. Default notifier labels breach `slow` vs event. 5 TDD cases in `tests/perf.test.ts`. Independent review: SPEC ✅ + QUALITY approved.
