# Task 6 Report — planning background backfill (09-impl T6)

## What I implemented

T6 adds the BACKGROUND backfill: on agent `session_start`, a deferred
`setTimeout(0)` re-mirrors `.planning/` so drift is healed without blocking
startup. It mirrors `src/handlers/session-backfill.ts` exactly (deferred
scheduling, run-state overlap guard, `MAX_FILES` bound, best-effort notify;
idempotency via the mirror's T3 hash-skip — no separate run-state file).

**Exports** (verbatim per brief): `schedulePlanningBackfill(repoRoot, memoryDir,
options?)`, `planningBackfillState`, `PLANNING_BACKFILL_MAX_FILES` (= **50**),
`waitForPlanningBackfill`.

## Files changed (5 — 3 named + 2 necessary enabling fixes)

### 1. NEW `src/handlers/planning-backfill.ts`
Mirrors `session-backfill.ts`. `collectPlanningMdFiles(repoRoot, maxFiles)` does a
bounded `.planning`-scoped recursive scan (NOT a full-repo walk). The deferred
task calls `walkAndIngest(files, { memoryDir, planningOnly: true })` — the same
T3/T4/T5 mirror (hash-compare INSERT/UPDATE/skip + delete reconciliation +
conflict-marker flag). Run-state guard returns `false` when `state.inProgress`.

### 2. NEW `src/handlers/planning-backfill.test.ts`
Brief's test verbatim (3 cases: re-mirror changed md within bounds via injected
inline `setTimeout`; skip when in-progress; `MAX_FILES > 0` export). Two brief
typos fixed: import path `../src/store/card-store.js` → `../store/card-store.js`
(test lives at `src/handlers/`); `as never` on a block-bodied arrow needed
parenthesization (`(() => { … }) as never`) to parse.

### 3. MODIFIED `src/index.ts` — wiring (non-blocking)
```ts
import { schedulePlanningBackfill } from "./handlers/planning-backfill.js";
…
    // immediately AFTER scheduleSessionBackfill(…):
    try {
      schedulePlanningBackfill(ctx.cwd, globalDir, { notify: (message, level) => { … } });
    } catch {
      /* never block startup */
    }
```
`globalDir` is the resolved hermes memory DB dir (same one
`createCardStore`/`scheduleSessionBackfill` use); `ctx.cwd` is the repo root.

### 4. MODIFIED `src/walk-and-ingest.ts` — `planningOnly` opt (additive)
Added `planningOnly?: boolean` to `WalkAndIngestOptions`; gates the zk knowledge
block: `const kp = opts.planningOnly ? undefined : getKnowledgePipeline();`.
Default `false` → **zero behavior change** for the existing caller
(`knowledge-ingest-tool.ts`). Rationale: without this, a seam-present-but-vault-
unset env makes `resolveKnowledgeVaultPath()` THROW inside `walkAndIngest`,
aborting the planning mirror — contradicting the documented "planning is
hermes-internal / no zk dependency" design. `planningOnly` makes the T6 backfill
truly seam-independent.

### 5. MODIFIED `src/knowledge-walk.ts` — classify bug fix (1 line)
`classify()` planned files via `planningCardKindFromSegs(relSegs)` (segments
RELATIVE to the walk root). For a bare-file input (`root === file`) or a
`.planning`-rooted walk, the rel path strips the `.planning` segment → planning
cards misclassify as `generic` (verified empirically: `array-of-files planning:
[]`, `planningDir planning: []`). Switched to the CANONICAL
`planningCardKindFromPath(abs)` used everywhere else (`mirrorPlanningToStore`,
`parsePlanningPath`, `reconcilePlanningDeletions`). For the standard
repo-rooted walk, `abs` and `rel` both contain `.planning` → identical behavior;
the fix ONLY adds correct classification where it was previously broken. This
makes the brief's intended bounded file-list approach work.

## Why 5 files, not the named 3

The brief's NOTE assumed `walkKnowledgeSources` classifies planning off the abs
path ("the planning classifier keys off the `.planning` segment in each abs
path, which the collected paths retain"). That assumption is **false** in T3's
code (it uses rel-segments), and `walkAndIngest` runs the zk knowledge path
(throwing if the vault env is unset) whenever the seam is present. Delivering the
brief's INTENT (bounded, file-list-scoped, seam-independent backfill) required
the two enabling edits above. Both are minimal and additive/bugfix in nature.

## TDD evidence

- **RED**: `bun test src/handlers/planning-backfill.test.ts` →
  `Cannot find module './planning-backfill.js'` (module absent) — captured before
  implementation. (One intermediate RED was a parse error on the brief's `as
  never` arrow cast; fixed by parenthesizing.)
- **GREEN**: same command → `3 pass / 0 fail`:
  - re-mirrors a changed planning md within bounds ✓
  - skips when a backfill is already in progress (run-state guard) ✓
  - exports a MAX_FILES bound (parity with session backfill) ✓

## Full-suite gate (run ONCE)

- `bun run check` (`tsc --noEmit`): **clean**.
- `bun test`: **1433 pass / 1 skip / 1 fail**.
  - The 1 failure is the KNOWN pre-existing ticket-04 time-bomb
    (`formatForSystemPrompt never emits memworth …` at
    `tests/store/memory-store.test.ts:2630`) — untouched.
  - Baseline after T5 = 1430 pass / 1 skip / 1 fail. Delta = **+3 pass** = my
    new T6 tests. **Zero new failures.**

## Self-review

- DoD met: changed planning md re-mirrored on `session_start` within MAX_FILES ✓;
  run-state prevents overlap ✓; index.ts non-blocking (try/catch) ✓; full suite
  green modulo the 1 known fail ✓.
- All pinned values verbatim: `PLANNING_BACKFILL_MAX_FILES = 50`; the four
  named exports; deferred `setTimeout(0)`; run-state guard; best-effort notify.
- The `planningOnly` opt and classify fix are both covered by the full suite
  (`knowledge-walk.test.ts` and all mirror-path tests pass unchanged) — no
  regression to T1–T5 behavior.
- Idempotency comes from T3's hash-skip (re-running on an unchanged corpus is a
  cheap hash-compare no-op); there is no separate run-state FILE, only the
  in-process run-state GUARD for overlap prevention, exactly as specified.

## Concerns

1. **Scope expansion**: 5 files committed, not the named 3. The 2 extra
   (`walk-and-ingest.ts`, `knowledge-walk.ts`) are necessary enabling edits to
   honor the brief's stated (bounded, file-list, seam-independent) intent — the
   brief's literal 3-file code was not runnable as written. Flagged for reviewer
   awareness; both edits are additive/bugfix and independently justified.
2. **Pre-existing latent classify bug** (now fixed): `planningCardKindFromSegs`
   on rel-segments was inconsistent with the canonical `planningCardKindFromPath`
   used everywhere else; it only "worked" by coincidence of the repo-rooted walk.
   The fix makes the system consistent.
3. The T6 backfill is the FIRST end-to-end exerciser of `walkAndIngest`'s
   planning mirror (T3/T4/T5 mirror logic had only building-block unit tests);
   this adds real integration coverage.
