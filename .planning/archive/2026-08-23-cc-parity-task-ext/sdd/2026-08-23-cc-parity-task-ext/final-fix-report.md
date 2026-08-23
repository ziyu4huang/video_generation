# Final fix wave — whole-branch review findings (2026-08-23)

Scope: all 12 findings from the final whole-branch review (PR #1897, branch
`cc-parity-task-ext`). TDD where behavior changed: failing tests written first,
confirmed red, then fixed green.

## Important findings

### 1. parseInterval accepts 0 / overflows setTimeout — FIXED
`src/loop/loop-commands.ts`
- Added `MIN_LOOP_INTERVAL_MS = 60_000` and `MAX_LOOP_INTERVAL_MS = 2_000_000_000`
  (~23 days, under setTimeout's 2^31-1 cap), documented as the timer-safety
  bound with the note that the scheduler's 7-day max-age still governs lifetime.
- `parseInterval` now clamps EVERY unit to `[MIN, MAX]` (seconds still round up
  to a whole minute first). Previously only "s" had the 60s floor, so "0m"/"0h"/
  "0d" → 0 ms and "999999999d" → 8.64e16 ms (timer overflow).
- Tests (`loop-commands.test.ts`): 0m/0h/0d/0s → 60_000; 999999999d/h and
  99999999m → 2_000_000_000; 1d/1h/1m unchanged.

### 2. Restored loop bypasses idle-gating — FIXED
`src/loop/loop.ts`
- Added module-level `latestIsIdle: () => boolean` (mirrors goal's
  `goalState.latestCtx` pattern). Every `/loop` command handler updates it from
  its ctx (`if (typeof ctx.isIdle === "function") latestIsIdle = ctx.isIdle`).
- `newScheduler`'s `isIdle` now reads `latestIsIdle()` instead of a per-call ctx
  default, so a restored scheduler (which has no ctx) gates on the last real
  command's idle state rather than always-idle.
- `__resetLoop` resets it to the `() => true` default for test isolation.
- Test (`integration.test.ts`): capture a BUSY ctx via `/loop status`, restore a
  persisted loop with a 20 ms interval (real timer), wait 80 ms → zero
  `sendUserMessage` fires (postponed, not fired). Was red before the fix.

### 3. restoreLoopFromSession orphans an active scheduler — FIXED
`src/loop/loop.ts`
- `if (schedulerRef?.active()) return;` after the persisted-loop load — a live
  loop wins; restore never overwrites (and thus never orphans) an armed timer.
- `extensions/task.ts` `session_shutdown`: added the explicit commented choice
  above `loopOverlay.dispose()` — the /loop scheduler is process-lifetime state
  with nothing per-session to clean (its timer dies with the process).
- Test (`integration.test.ts`): start `/loop 5m live loop`, persist a DIFFERENT
  loop, restore → `/loop status` still reports "live loop".

### 4. Overlay frozen after first fire — FIXED
`src/loop/loop-scheduler.ts`, `src/loop/loop.ts`
- `SchedulerHooks` gained optional `onTick?: (loop: ActiveLoop) => void` and
  `onStop?: () => void` observers (the scheduler owns the only mutable copy of
  the loop, so mirrors need a notification channel).
- `LoopScheduler.tick` calls `onTick(this.loop)` after each successful fire's
  state update, and `onStop()` after the 7-day max-age self-stop's final
  dispatch.
- `loop.ts`'s `newScheduler` wires `onTick` → `overlay.update(loop)` and
  `onStop` → `overlay.update(undefined)` + `clearPersistedLoop(extensionApiRef)`,
  so the overlay stays live and a max-age expiry clears persistence.
- Tests (`loop-scheduler.test.ts`, harness now accepts extra hooks): onTick
  fires with iterations [1, 2] and the re-armed `nextFireAt`; onStop fires once
  on max-age (and not on an ordinary fire).

## Deferred-minor (fix-now per triage)

### 5. validate-questionnaire unguarded accesses — FIXED
`src/ask-user/tool/validate-questionnaire.ts`
- `q.header` guarded (`if (q.header && q.header.length > MAX_HEADER_LENGTH)`)
  with a one-line comment (unvalidated runtime payloads may omit it).
- Sibling `hasRecommendedSuffix(o.label)` guarded as `o.label && …` (same
  presence-guard style as the neighboring label checks).

### 6. Preview header shows raw suffixed label — FIXED
`src/ask-user/view/components/preview/preview-block-renderer.ts`
- Header line now renders the display label with `RECOMMENDED_SUFFIX` stripped
  (same strip style as the option-list views; ⭐ stays an option-list
  affordance).
- Added the reviewer-requested comment at the clip: code-unit clip, wide chars
  (CJK/emoji) may clip a cell early — documented limitation.
- Test (`recommended-marker.test.ts`): preview header renders "Preview: Alpha"
  with no "(Recommended)".

### 7. MultiSelectView star/strip path untested — FIXED
`src/ask-user/__tests__/recommended-marker.test.ts`
- New render test mirroring the WrappingSelect test shape: constructs
  `MultiSelectView` directly with a suffixed first option, asserts ⭐ present,
  "Alpha" present, "(Recommended)" absent from display.

## Cheap minors

### 8. Old-syntax guard false-positives on "start …" prompts — FIXED
`src/loop/loop-commands.ts`
- Old syntax is now only `measure=…` as the first token, or `start` followed by
  a token starting with a quote or `measure=`. "/loop start the servers" falls
  through to a normal start-result (default 10m interval).
- Tests: "start the servers" → start-result; `start "improve x"` and
  `start measure=echo` still yield the usage pointer.

### 9. Dead showStopped() — FIXED
`src/loop/overlay.ts`
- Deleted `showStopped()` (never called anywhere) plus its now-dead
  `flashTimer` / `clearFlashTimer` / `STOP_FLASH_MS` scaffolding. Issue-4's
  `onStop` wiring uses `update(undefined)` as instructed.

### 10. Wizard openUrl — FIXED
`bun-apps/s2-agent-ext-wayfind/skills/wizard/template.ts`
- Success check is now `spawnSync(...).status === 0` (not `!r.error`) — a found
  binary exiting non-zero (WSL's xdg-open without a display) falls through to
  the next candidate.
- Candidate order now `open → wslview → xdg-open → explorer.exe` (bash original
  order; wslview before xdg-open).

### 11. Wizard writeEnv preserves blank lines — FIXED
Same file.
- Dropped the `l !== ""` filter (interior blank lines preserved); to keep the
  upsert idempotent, split()'s single trailing `""` (the file's final newline)
  is stripped before filtering and the file is rewritten with one trailing
  newline — re-running no longer accumulates blank lines AND no longer
  collapses the author's blank-line grouping.

### 12. map.md Fog of war "Label hard limit" — FIXED
`.planning/2026-08-23-cc-parity-task-ext/map.md`
- Rewrote the entry to match what shipped: ticket 01 removed the 60-char
  rejection and kept NO guardrail (long labels simply wrap); the stale "exact
  number decided in ticket 01" sentence is gone.

## Extra (not in findings list)

- `src/goal/__tests__/goal.test.ts` was RED on the branch before this wave
  (pre-existing): a prior ticket changed the `/goal clear` completion
  description to "Clear the current goal (stop|off|reset|none|cancel also
  work)" (commands.ts:53) without syncing the test expectation. Synced the
  expected string so the package gate is green. No production code changed.

## Out of scope (per triage, untouched)

- interval h/d display formatting (review minor 11, cosmetic).
- `isLoopActive` doc comment: added a one-line comment while in the file
  (explicitly allowed).

## Gates

- `( cd bun-apps/s2-agent-ext-task && bun run typecheck && bun test )`:
  tsc clean, **880 pass / 0 fail** (61 files, 5210 expect() calls).
- `( cd bun-apps/s2-agent-ext-wayfind && bun run check && bun run typecheck && bun test )`
  (touched by the wizard template fix): biome clean, tsc clean,
  **473 pass / 0 fail**.

## Concerns

- `bun-apps/s2-agent-ext-superpowers/skills/systematic-debugging/scripts/hitl-loop.template.ts`
  also contains a `wslview` openUrl (found while fixing #10) and may carry the
  same `!r.error` / ordering bug. Out of this wave's scope — flagging for a
  follow-up check by the template's owner.
