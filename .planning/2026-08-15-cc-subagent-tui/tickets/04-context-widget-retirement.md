# Ticket 04 — Context-widget retirement

> Wave 1 · spec §2 · status: **stub** (awaiting plan)

## Goal

Delete `subagent-context-widget.ts` (non-focusable widget + Ctrl-O `\x0f` byte-sniff
`:50–55`, REVIEW subagent #1) and `installSubagentContextWidget` wiring. Migrate unique
behavior — collapsed latest-line via `latestMessageLine` (`subagent-tool-render.ts:97`) — into
the new section (ticket 01). `/subagents` viewer unchanged.

## Acceptance criteria

- File + install path + `install-subagent-context-widget.test.ts` deleted; no `\x0f` sniff remains.
- `latestMessageLine` behavior lives in the new section (regression test).
- `/subagents` viewer tests green, untouched.

## Files

- `bun-apps/pi-agent-ext-subagent/src/subagent-context-widget.ts` (delete)
- `bun-apps/pi-agent-ext-subagent/extensions/subagent.ts` (unwire install)
- `bun-apps/pi-agent-ext-core-task/src/subagents/` (latest-line migration)

## Gate

`( cd bun-apps/pi-agent-ext-subagent && bun run test )` +
`( cd bun-apps/pi-agent-ext-core-task && bun run typecheck && bun test )`
