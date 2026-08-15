# Ticket 08 — Dock mode implementation (core-task)

> Wave 3 · spec §4 · status: **DONE** (#1441)

## Goal

Implement the dock focus mode in core-task per the ticket-07 ADR: prefix-claim entry, Esc
release, table-driven keymap (`j`/`k` scroll, `x` abort + y/n confirm, `e` trace overlay via
`formatSubagentTrace`, Ctrl-B background, `Enter` → `/subagents` viewer focused on the run).
Consumes ONLY the subagent package's public surface (spec §1 typed-import direction).

## Acceptance criteria

- Table-driven keymap tests cover every protocol key + Esc release (no real terminal needed).
- Entry/release don't leak claimed keys to the editor after release.
- Manual TUI smoke script (focus/scroll/abort/expand/detach/jump against a real child run)
  committed and executed once.

## Files

- `bun-apps/pi-agent-ext-core-task/src/subagents/dock.ts` (+ tests)
- `bun-apps/pi-agent-ext-core-task/extensions/core-task.ts` (wiring)
- smoke script under `bun-apps/pi-agent-ext-core-task/` (docs or scripts)

## Gate

`( cd bun-apps/pi-agent-ext-core-task && bun run typecheck && bun test )` +
`( cd bun-apps/pi-agent-ext-subagent && bun run test )` + smoke script run
