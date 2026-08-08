# 02 — tool-gate ensureSeeded in before_agent_start (#2)

**Status:** TODO

## Change
In `pi-agent-ext-tool-gate/extensions/tool-gate.ts`, make `before_agent_start` self-seeding: when `sticky` is empty (the in-process-subagent-child case that skipped `session_start`), seed `sticky = new Set(effectiveCore)` and build `measuredTokens` once — exactly what `session_start` does.

## Why
The child never fires `session_start`, so its gate runs on an empty `sticky` (core tools un-sticky → asymmetric gating) and re-measures tokens every turn. A surgical `ensureSeeded()` in tool-gate's own closure fixes both without touching any other extension's state.

## KEY CONSTRAINT
Do NOT instead fire `bindExtensions()`/`session_start` in the child — that would wipe the parent's core-task state (shared module singletons; see map.md KEY CONSTRAINT). #2 stays surgical to tool-gate's closure only.

## Verification
- `pi-agent-ext-tool-gate` `bun test` green + `bun run qa` PASS.
- Add a test simulating a child (drive `before_agent_start` without a prior `session_start`) asserting `sticky` gets seeded from `effectiveCore` and core tools end up active.
