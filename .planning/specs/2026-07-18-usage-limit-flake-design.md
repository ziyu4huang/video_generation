# Design — usage-limit flake fix (cross-file HOME race)

> Brainstorming output for the SDD dogfood task. Approved approach A.

## Problem

`tests/usage-limit-integration.test.ts` intermittently times out (5s) under full-suite (`bun test`) load, but passes in isolation. Root cause: **9 test files** (`workflow-settings`, `workflow-manager`, `workflow-manager-abort`, `workflow-saved`, `workflow-paths`, `usage-limit-integration`, `run-persistence`, `saved-commands`, `logger`) all mutate the **process-global** `process.env.HOME` / `USERPROFILE` via `tests/helpers/fake-home.ts`. `bun test` runs files **concurrently** by default (no `concurrency` setting) → the files race on HOME → `usage-limit-integration`'s real faux session reads a clobbered HOME mid-run → hangs → 5s timeout. Any of the 9 could flake; `usage-limit-integration` is the most timing-sensitive (it drives a real `WorkflowAgent.run`).

## Solution (approved: A)

Add a **cross-file async mutex** to `tests/helpers/fake-home.ts`. `withFakeHomeAsync` acquires a module-level promise-queue around its install/restore critical section, so all HOME mutations across all files serialize. ~15 lines; fixes all 9 files at the source.

## Out of scope

- `bunfig.toml` `concurrency: 1` (approach B — serializes the whole 49-file suite, too slow/broad).
- Refactoring `src/home.ts` consumers off process-global HOME (approach C — overkill).
- Changing bun's concurrency model.

## Testing

- **Unit (TDD):** a concurrency test asserting 2-3 concurrent `withFakeHomeAsync` calls have **non-overlapping** critical sections (max 1 active window).
- **Stabilization (final review):** full `bun test` run N× with zero flakes.
- **Audit:** confirm all 9 files go through the (now-serialized) helper; any sync `withFakeHome` caller that could run alongside the faux session is converted to async (sync can't await the mutex).

## Risk

The sync `withFakeHome` variant cannot await the mutex. If any of the 9 files use the sync variant concurrently with the faux session, they'd still race. Mitigation: audit + convert (Task 1 covers this).
