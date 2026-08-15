# Ticket 07 — Focus-claim ADR + protocol (BEFORE ticket 08)

> Wave 3 · spec §4 · status: **done** (PR #1437) — docs-only, hard gate cleared for ticket 08

## Goal

Write the ADR recording the focus-claim convention and then specify the protocol:
`Ctrl-G s` enters dock focus mode via `onTerminalInput` prefix claim; `Esc` releases. Keys:
`j`/`k` scroll, `x` abort (with `y`/`n` confirm), `e` expand trace overlay
(`formatSubagentTrace`), Ctrl-B background (ticket 05), `Enter` jumps to `/subagents` viewer
focused on the run. Zero upstream pi-core changes; ADR records the future
upstream-focus-API migration path (consistent with
`docs/research-tui-agent-webui-hybrids.md`).

## Acceptance criteria

- ADR written, ID'd, and listed in the package ADR index; cites REVIEW subagent #1 root cause.
- Protocol documented (claim prefix, release key, full keymap) with zero-upstream constraint.
- No implementation in this ticket (ADR + protocol only).

## Files

- `bun-apps/pi-agent-ext-core-task/docs/adr/` (new ADR, per package CONTEXT conventions)

## Gate

ADR index resolves; `bun run test:adr` (from `bun-apps/`) passes; core-task typecheck green.
