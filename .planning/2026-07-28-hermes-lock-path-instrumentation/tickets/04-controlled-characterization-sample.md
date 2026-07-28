---
type: task
blocking: 02, 03
status: closed
---

# 04 — Controlled characterization sample

## Question

Produce the first reproducible `perf.jsonl` sample off the newly-instrumented
lock path via a deterministic, LLM-free characterization test — the D3
deliverable that closes the data-driven loop in one iteration instead of
ship-and-wait for a real storm.

## What to build

A deterministic test that exercises the **real** overflow → consolidation →
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

## Acceptance

- [ ] Test triggers a real overflow → consolidation → lock-hold via `_add` with
      a tiny Failure char limit + mock consolidator (no real LLM).
- [ ] `perf.jsonl` contains a `consolidation.failure` record after the run.
- [ ] When the mock consolidator sleep exceeds the lock threshold, `perf.jsonl`
      **also** contains a `fileLock.hold.failure` breach.
- [ ] A variant with a terminating mock consolidator stamps `timedOut: true` on
      the consolidation record.
- [ ] The test is deterministic, fast, LLM-free, Surreal-free (no network /
      subprocess), and runs under the package's normal `bun test`.
- [ ] The test docstring documents the honest scope (hold + timeout frequency;
      explicitly NOT real cross-process `ELOCKED` counts).

## Resolution (closed 2026-07-28)

Implemented in `tests/store/characterization-sample.test.ts` (commit ae469d4c). Tiny `failureCharLimit` + mock consolidator sleep + low lock threshold → real `_add` overflow → asserts BOTH `consolidation.failure` + `fileLock.hold.failure` in perf.jsonl, plus a terminating variant (`timedOut:true`). Honest-scope docstring (hold + timeout; not real ELOCKED counts). 2 TDD cases. Review: SPEC ✅ + QUALITY approved.
