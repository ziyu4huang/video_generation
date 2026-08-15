# Ticket 05 — Detach pipeline (foreground → background)

> Wave 2 · spec §3 · status: **stub** (awaiting plan)

## Goal

Foreground run converts to background inside the subagent package: child process survives,
parent's awaited tool call resolves with a detached outcome, persistence owns the run
(`subagent-run-persistence.ts`), RunView stays live via registry (foreground flips false →
appears in the new section).

## Acceptance criteria

- Child-alive-after-detach test: child process outlives parent release.
- Parent turn resumes (tool resolves) without aborting the child.
- Detached run survives resume (persistence round-trip).

## Files

- `bun-apps/pi-agent-ext-subagent/src/spawn-subagent.ts` / `subagent-tool-run.ts` (detach lever)
- `bun-apps/pi-agent-ext-subagent/src/subagent-run-persistence.ts` (ownership)

## Gate

`( cd bun-apps/pi-agent-ext-subagent && bun run test )`
