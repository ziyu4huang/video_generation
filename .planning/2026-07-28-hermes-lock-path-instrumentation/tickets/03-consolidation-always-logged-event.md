---
type: task
blocking: 01, 02
status: closed
---

# 03 — Consolidation always-logged event

## Question

Make every **Auto-consolidation** run observable: wrap `runConsolidator`'s
consolidator call with the always-persist path (T1), recording target,
duration, and whether the child timed out — the dataset that decides #853 / #854.

## What to build

`runConsolidator` wraps the `this.consolidator(target, signal)` call with
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

## Acceptance

- [ ] Every consolidation run produces a `consolidation.<target>` record
      (always-logged, even when fast / under any threshold).
- [ ] The record's `timedOut` is `true` when the child result indicates
      termination, `false` otherwise.
- [ ] `kind: "consolidation"` is stamped; op namespace is
      `consolidation.<target>`.
- [ ] A consolidation whose hold also crosses the lock threshold additionally
      produces the `fileLock.hold.<target>` breach (T2) — both records present.
- [ ] Consolidation functional behavior is unchanged (bypass env, single retry,
      vault-offload floor); existing consolidation tests pass.
- [ ] The notifier level for the consolidation event is decided + documented
      (expected / info, not warn); no second notifier channel added.

## Resolution (closed 2026-07-28)

Implemented in `src/store/memory-store.ts` (runConsolidator wraps the consolidator call with `timedAlways` as `consolidation.<target>`, `timedOut` from `ConsolidationResult.terminated`), `src/types.ts` (+`terminated?`), `src/handlers/auto-consolidate.ts` (sets `terminated: result.timedOut`), `src/perf.ts` + `src/index.ts` (notifier info/warn split). Commit 921c4e83. 2 TDD cases in `tests/store/consolidation-perf.test.ts`. Review: SPEC ✅ + QUALITY approved.
