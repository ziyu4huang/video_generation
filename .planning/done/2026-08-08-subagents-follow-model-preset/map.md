---
effort: 2026-08-08-subagents-follow-model-preset
title: Subagents follow the active model-preset on fallback
created: 2026-08-08
last: 2026-08-08
status: complete
---

## Question

Subagents should follow the `/models-preset` by default: when an explicit
`model` is unavailable in this environment, it must degrade to the preset (via
the caller's `tier`) — not silently to an arbitrary session default.

## Map

- [x] ticket 01 — fallback to tier (preset) before session default + warn

## Fog

- Root-origin found (LLM free choice, not a config/instruction bug) — cleared.

## Notes

- Root cause = the orchestrator LLM freely chose an explicit `model` (e.g.
  `anthropic/claude-opus-4-1`, unavailable in this env) — no agent def and no
  instruction constrain it (self-reinforcing precedent). The resolution bug:
  `resolveAgentModelSpec` short-circuits on an explicit `model`, so the caller's
  `tier` never runs; then when the explicit model is unavailable, the fallback
  discarded `tier` entirely and landed on the session default.
- Fix is tool-level (`WorkflowAgent.run`'s fallback branch in
  `agent.ts`) — the one layer the LLM can't bypass. An explicit available model
  still wins (Stage A unchanged); only the UNAVAILABLE path now consults the
  caller's tier (→ active preset) before the session default.
- Related: `2026-08-08-subagent-display-glanceable-by-default` ticket 03 makes
  the fallback visible in the TUI (shows requested → actual). This fix changes
  WHAT the fallback model is (the preset, when a tier is present); ticket-03's
  display already reflects it via `onModelResolved(actual)`.
