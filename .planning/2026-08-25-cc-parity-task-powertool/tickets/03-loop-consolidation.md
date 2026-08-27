# Ticket 03 — Loop consolidation onto WakeupRegistry

Status: closed

Closed 2026-08-28 via PR #2108 (squash `fff48bfc`, merged CLEAN, local_ci
pass 111s). Investigation outcome: WakeupRegistry hosts both ported
behaviors natively — idle-postpone became "busy ⇒ the whole tick no-ops"
(finer than LoopScheduler's 60s postpone, same never-drop contract), and
restart-restore lives in a new `src/wakeup-persistence.ts` (session-store
snapshots under `wakeup-loop-state`; future dueAt honored, stale fixed
re-anchors a full interval, stale dynamic re-anchors to NOW, expired
dropped). Day-scale cadences kept legal (fixed clamp 60s–7d, the max-age
ceiling — NOT schedule_wakeup's 60–3600s). `/loop stop` kept as an alias
of `off`. The ext-task overlay renders from a new `__piWakeupLoops`
globalThis seam (registered in SEAM_KEYS + SeamImplMap — the seam-contract
ORPHANS invariant caught the unregistered key, as designed). Two
incidental fixes: slash-prompt loop fires now expandPromptTemplates (the
retired scheduler's 2026-08-23 probe — the consolidated fire had dropped
it), and file2md's pre-existing ext-dir-unwrap lint error (from #2102,
surfaced by dependency-scoped local_ci). Session-store compat decision
(scope 4): old ext-task `loop-state` entries are NOT migrated — inert
session history once its loader is gone. Net −238 lines.

## Why

Two `/loop` implementations exist: ext-task's LoopScheduler (fixed 1m–23d
cadence, idle-postpone, session-store restore — restore cadence + unref
fixed in PR #2030) and ext-ultracode's `/loop` + `schedule_wakeup`
(dynamic 60–3600s pacing, fire cap, footer discipline — the CC-faithful
core per subagent-cc-parity-2 ticket 06). Same command name, divergent
verbs (`stop` vs `off`), `/loop:2` redirect papering the collision (map D3).

## Scope

1. **Investigate first**: whether ultracode's WakeupRegistry can host
   idle-postpone (fire while busy ⇒ re-check) and restart-restore
   (persisted nextFireAt honored, idle-gated) without an import cycle with
   ext-task. The restore gate on `latestIsIdle` (loop.ts:10-13) is the
   pattern to port.
2. **Port the two missing behaviors** into the ultracode loop family
   (scheduler + persistence layers there), with the PR #2030 semantics:
   future persisted nextFireAt honored; stale one re-anchors.
3. **Retire ext-task's LoopScheduler** (`src/loop/loop-scheduler.ts`,
   `loop-persistence.ts`, the `/loop` registration in loop.ts) — ext-task
   keeps ONLY the composite-widget `loop` overlay section (order 0),
   fed by the surviving mechanism's state. The `/loop` command resolves to
   ONE implementation; delete the `/loop:2` redirect + divergent verbs.
4. **Session-store compatibility**: decide whether old persisted
   `loop-state` entries migrate or are dropped on first read (record the
   call in the ticket; dropping with a one-line notice is acceptable for
   session-scoped state).
5. Tests: consolidate the ext-task loop tests (scheduler chain, restore
   cadence, idle gate) against the surviving implementation; keep the
   overlay rendering tests in ext-task.

Not in scope: cron (durable store untouched); goal; ultracode's workflow
loop globals; the `/loop dynamic` pacing internals.

## Done-when

- [ ] One `/loop` command; `grep -r "LoopScheduler" bun-apps` returns only
      the ultracode implementation's file (or nothing, if renamed there).
- [ ] Idle-postpone + restore-cadence behaviors exist on the surviving
      implementation, test-pinned.
- [ ] ext-task composite widget still renders the loop section; ext-task
      + ultracode gates green; PR merged CLEAN.
