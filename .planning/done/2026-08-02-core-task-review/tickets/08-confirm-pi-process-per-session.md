---
type: research
status: closed
blocked by:
findings: H5
resolved: 2026-08-12 — shipped in #1075 + #1133 — pi runs one process per session (documented); todo store re-keyed per sessionId
---

# 08 — Confirm pi's process-per-session guarantee (todo store concurrency safety)

## Problem

The todo store is a single module-level `let state` (`store.ts:8`), reset on `session_start`. This is correct for **sequential** sessions, but if pi ever hosts **two concurrent sessions in one process**, they share the cell and clobber each other's todos. Whether that can happen depends on pi's concurrency model — which is **unverified**.

## Evidence

- `core-task/src/todo/state/store.ts:8` (`let state`), `extensions/core-task.ts:93` (`replaceState(EMPTY_STATE)`), `TodoOverlay` constructed once per load (`extensions/core-task.ts:62`).

## Research questions

1. Does pi spawn one process per session, or can multiple sessions share a process? Check pi-coding-agent's session/cluster spawning (grep the SDK for `fork`/`cluster`/`child_process`/`SessionManager` process model).
2. If concurrent-in-one-process is possible: is it per-cwd, per-worktree, or arbitrary?
3. How do the other `globalThis` singletons (`__piGoalActive`, the status widget) already assume this — is there an established repo convention for "session-scoped vs process-scoped"?

## Outcome

- **If one-process-per-session is guaranteed:** add a one-line comment to `store.ts:8` documenting the assumption (closes H5 as "safe-by-assumption").
- **If concurrent sessions can share a process:** open a follow-up implementation ticket to key the store (and the `TodoOverlay`) by session id.

## Acceptance

- [ ] pi's process model confirmed with a citation (SDK file:line or doc).
- [ ] Either the assumption is documented, or a follow-up implementation ticket is filed.
