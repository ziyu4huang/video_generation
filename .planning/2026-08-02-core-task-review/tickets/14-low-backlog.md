---
type: task
status: closed
blocked by:
findings: L1, L4, L5, L6, L7, L8, L10, L12
resolved: 2026-08-12 — shipped in #1074 — LOW batch (EMPTY_STATE freeze; heartbeat cleanup; +6)
---

# 14 — LOW cleanup backlog (batch the minor items)

A single batch ticket for the LOW findings that aren't coupled to a HIGH/MED ticket. Tackle together in a low-priority pass; un-check items you'd rather drop.

## Items

- **L1** — `backoffMs(0)` on the non-stuck continuation is a dead exponential. `core-task/src/goal/goal.ts:931` + `backoff.ts:8-9`. Either pass `backoffMs(goalState.consecutiveStuck)` (resets to 0 anyway) or delete the import + 3-line wait block. Keep `shouldPauseAfterBackoff`.
- **L4** — `EMPTY_STATE` assigned by **reference** on session reset (not copied/frozen). `state.ts:12`, `extensions/core-task.ts:93`. `Object.freeze` it, or `replaceState({ tasks: [], nextId: 1 })` (fresh object) on session_start.
- **L5** — task-graph cycle check conservatively over-merges (harmless). `task-graph.ts:17-19` vs `state-reducer.ts:87-99`. Pass the already-merged set and have `detectCycle` replace; add a simultaneous add+remove test.
- **L6** — tree-connector `├─`→`└─` string-replace can clobber a subject containing the literal. `overlay.ts:148-150`. Track the connector slot structurally instead of `String.replace`.
- **L7** — `truncateToWidth` ANSI-awareness unverified; no render test. `overlay.ts:121`. Confirm pi-tui handles ANSI; add a long-subject + non-default-theme render test.
- **L8** — `/todos` command + `list` output unbounded/untruncated. `view/format.ts:92`, `tool/response-envelope.ts:6-10`. Optionally truncate subject to a sane width in `formatCommandTaskLine`.
- **L10** — concurrent/cross-session store isolation untested. `store.ts:8`. Add a test: populate state, `replaceState(EMPTY_STATE)`, assert empty + fresh `create` restarts at id 1. (Pairs with ticket 08's research outcome.)
- **L12** — `__piKickHeartbeat` never unpublished on unload (benign); reader-idiom doc drift. `goal.ts:944`. Clear it in goal's `session_shutdown` for symmetry; align CONTEXT.md reader idiom with the code (`typeof === "function" ? fn() : fallback`).

## Acceptance

- [ ] Each kept item addressed or explicitly deferred with a note.
- [ ] `bun test` green; no regressions.
