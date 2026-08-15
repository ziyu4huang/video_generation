# Ticket 02 — Completion notification line

> Wave 1 · spec §2 · status: **done** (PR #1412)

## Goal

Transient top-of-section line when a background run completes: run name + elapsed + one-line
summary (RunView `latestAction`), fading next render tick; terminal bell (`\x07`) once.

## Acceptance criteria

- Notify line appears on completion, disappears on the next tick (fade test).
- Bell emitted exactly once per completion.
- State is section-internal (no new widget, no toast system).

## Files

- `bun-apps/pi-agent-ext-core-task/src/subagents/` (notify state + render + tests)

## Gate

`( cd bun-apps/pi-agent-ext-core-task && bun run typecheck && bun test )`
