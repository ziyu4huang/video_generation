# Task 1 Report — zk-spawn: Characterize lifecycle fns

## What I did

Created `bun-apps/pi-agent-ext-wayfind/tests/lifecycle.test.ts`, a characterization test
suite for the three lifecycle functions in `src/map.ts` that currently have no test
coverage: `doneDir`, `setEffortStatus`, `completeEffort`. This establishes a safety net
before Tasks 2–3 move these functions out of `map.ts`.

Before writing, I verified the real signatures/behavior against `src/map.ts` lines
457–524 (the task's referenced range):

- `doneDir(cwd): string` → returns `join(cwd, ".planning", "done")` ✓
- `setEffortStatus(cwd, effort, status): SetStatusResult` where
  `SetStatusResult = { ok: true } | { ok: false; reason: string }`:
  - refuses `{ ok: false, reason: "no map at .planning/${effort}/map.md" }` when no
    map.md (reason contains "no map") ✓
  - on success writes the new status in place via `serializeMapFrontmatter`
    (which preserves `created`) and returns `{ ok: true }` ✓
- `completeEffort(cwd, effort): CompleteEffortResult`:
  - success: `{ ok: true, effort, movedTo: ".planning/done/${effort}" }` ✓
  - no map.md: `{ ok: false, effort, reason }` ✓
  - destination exists: `{ ok: false, effort, reason: "destination already exists: …" }`
    (reason contains "already exists") ✓

All real signatures matched the test expectations verbatim, so no test correction was
needed and `src/map.ts` was NOT modified.

## Test results

New file run alone (`bun test tests/lifecycle.test.ts`):

```
6 pass, 0 fail, 14 expect() calls, 1 file
```

Breakdown:
- `doneDir > returns the <cwd>/.planning/done archive root` — pass
- `setEffortStatus > writes the new status into the map front-matter in place and returns ok` — pass
- `setEffortStatus > refuses {ok:false} when no map.md exists` — pass
- `completeEffort > stamps status:complete and moves the effort dir under .planning/done/` — pass
- `completeEffort > refuses {ok:false} when there is no map.md` — pass
- `completeEffort > refuses {ok:false} when the destination already exists (no clobber)` — pass

## Gate output summary

Full gate (`bun run check && bunx tsc --noEmit && bun test`) — all green:

- `bun run check` (biome): `Checked 42 files. No fixes applied.` — clean.
- `bunx tsc --noEmit`: no diagnostics.
- `bun test` (whole package): `307 pass, 1 skip, 0 fail, 625 expect() calls, 20 files`.

The build step (`bun run build`) was deliberately NOT run, per the task constraint (it
re-vendors mermaid).

## Commit

- SHA: `70309460248196a6016608e0d168563b93178386`
- Message: `test(wayfind): characterize lifecycle fns (setEffortStatus/completeEffort/doneDir)`
- Files: 1 file changed, 92 insertions (only `tests/lifecycle.test.ts`).
- Branch: `feat/wayfind-architecture-deepening` (based on 4084250).

## Deviations from the task text

1. **Removed an unused import.** The verbatim file content in the task included
   `import type { EffortMeta } from "../src/map.js";`, but `EffortMeta` is never
   referenced anywhere in the test body. This unused import causes `bun run check`
   (biome `lint/correctness/noUnusedImports`) to error and exits non-zero, which would
   violate the task's firm requirement that the gate "Must be green." Per the report
   contract (which anticipates deviations), I removed that single line. All other
   content is verbatim from the task spec. Downstream tasks that import `EffortMeta`
   into this file can re-add it if needed.

2. **Test count: 6, not 5.** The task body said "they should PASS at once (5 tests)",
   but the provided content actually defines 6 `it(...)` blocks (1 for `doneDir`, 2 for
   `setEffortStatus`, 3 for `completeEffort`). I followed the provided content verbatim
   (6 tests). This is a count mismatch in the task text, not a behavioral deviation;
   all 6 pass.
