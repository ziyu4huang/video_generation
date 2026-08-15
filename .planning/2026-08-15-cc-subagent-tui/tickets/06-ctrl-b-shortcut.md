# Ticket 06 — Claimable ctrl+b shortcut (global + in-viewer)

> Wave 2 · spec §3 · status: **stub** (awaiting plan)

## Goal

Register claimable `ctrl+b`: global (`pi.registerShortcut`) for the current foreground run;
in `/subagents` viewer for the focused run. Detaches via ticket 05 lever; post-detach notify
line (ticket 02 mechanism) confirms "detached → background". No focus required (pattern per
`subagent-context-widget.ts:24–25` key-path guidance).

## Acceptance criteria

- ctrl+b detaches foreground run globally and in-viewer (table-driven tests).
- Post-detach notify line fires once.
- No conflict with existing viewer keymap.

## Files

- `bun-apps/pi-agent-ext-subagent/extensions/subagent.ts` (shortcut registration)
- `bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts` (in-viewer key)

## Gate

`( cd bun-apps/pi-agent-ext-subagent && bun run test )`
