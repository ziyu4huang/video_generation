# Ticket 10 — Dock focus: wire it or delete it

Status: pending

## Why

The subagents dock focus pair (`src/subagents/dock.ts` + `dock-claim.ts`,
314 lines) implements Ctrl-G `s` prefix-claim keyboard focus (j/k, x-then-y
abort, e trace expand, ctrl+b detach, Enter viewer, Esc release) per
ADR-task-0001 — built, tested (314-line test suites), and NEVER WIRED: the
entry uses only `.section`/`.dispose()` (task.ts:110-114); `setNotifyLine`/
`setDockState` have zero production callers, so `DOCK_HINT_LINE` is
unreachable outside tests.

## Scope

1. **Decide (in-ticket, one paragraph in the map's Decisions)**: wire or
   delete. Wiring criteria: the claim surface composes with the tui-cc-parity
   effort's keymap decisions (alt+b panel, Esc interrupt — its tickets 02/03
   touch the same input seam; READ that map first, cite its D4) and does not
   collide with pi's keymap (the ctrl-b.ts precedent documents the collision
   class). Deleting criteria: the `/subagents` viewer already covers the
   interactions and the ADR's premise (in-widget focus) is stale.
2. **If wiring**: register the claim in `session_start` via the
   `onTerminalInput` seam (the ask-user modal's precedent,
   ask-user-question.ts:149-150); wire `setDockState`/`setNotifyLine` from
   the subagents handle; the dock claims keys ONLY while background runs
   exist and the claim is armed (never steal editor keys otherwise).
3. **If deleting**: remove dock.ts + dock-claim.ts + their tests + ADR-task-0001
   (mark it Superseded with the deletion rationale; ADRs are never silently
   dropped — move to the package's adr dir convention for superseded) +
   the `DockRenderState` exports the section still uses (keep the section's
   own rendering path intact).
4. Either way: CONTEXT.md / spec.md §1 updated; tui-cc-parity map's fog
   cross-checked (its alt+b ticket 03 may make the dock the panel target —
   coordinate, don't duplicate).

Not in scope: new dock features; the subagents viewer itself; notify lines.

## Done-when

- [ ] Either the dock is reachable in a live TUI (manual receipt: Ctrl-G s
      → j/k/x/e/Enter/Esc work against live runs) or the 314 lines + ADR
      are gone with the rationale recorded.
- [ ] No unreachable exports remain (grep DOCK_HINT_LINE → one live path
      or zero hits).
- [ ] Canonical gates green; PR merged CLEAN.
