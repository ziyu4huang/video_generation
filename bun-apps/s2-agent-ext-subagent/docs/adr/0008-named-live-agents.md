**ID:** `ADR-subagent-0008` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: repo-root `CONTEXT-MAP.md`

# 0008 — Named live agents retain in-process child sessions; budgets aggregate over the agent's lifetime

**Status:** accepted
**Date:** 2026-08-22
**Plan:** `.planning/2026-08-22-subagent-teams-parity/` (ticket 01)

## Context

Until now every subagent dispatch was one-shot by doctrine (CONTEXT.md, before
this effort): `CoreAgent.run` creates a child session, prompts once, disposes
in its `finally` (`agent.ts`). That matched the tool surface — but it made the
Claude Code SendMessage/agent-teams vocabulary unimplementable: there was no
way to ask a completed agent a follow-up question, because nothing of it
survived its first report. `pi` sessions are multi-turn reusable
(`session.prompt` again after completion; `steer` into a running one;
`getSessionStats()` cumulative over the session's lifetime), so the capability
was one architectural decision away.

The decision has two irreversible-feeling consequences that make it an ADR
rather than an effort-map note:

1. **Memory profile**: a named agent holds a live in-process session (message
   history + tool instances + an event subscription) for as long as it stays
   registered — across turns, potentially for the whole session.
2. **Budget-accounting granularity changes meaning**: the dispatch envelope
   (`tokenBudget`/`maxTurns`) was per-dispatch. On a persistent session the
   same guard reading cumulative stats becomes per-AGENT-LIFETIME — a named
   agent exhausts its envelope across exchanges and never gets it back.

## Decision

- `spawn_subagent` gains an optional `name`. A named dispatch runs its first
  exchange through a NEW persistent-agent path in core-runtime
  (`persistent-agent.ts`: `openLiveAgent` / `LiveAgent.send`) that shares
  session assembly with the one-shot path via `CoreAgent.assembleSession()`
  (extracted verbatim from `run()`), then REGISTERS the session in a new
  process-singleton `LiveAgentRegistry` instead of disposing it.
- Budget/turn guards attach ONCE at open and live for the agent's lifetime:
  the ceilings passed at spawn bound every future exchange in aggregate.
  `timeoutMs` stays per-exchange (a wall-clock hang is a property of one
  prompt, not of an agent). A fired lifetime ceiling terminalizes the agent —
  later sends return the failure without prompting.
- Eviction: LRU capped by `SUBAGENT_MAX_LIVE` (default 6, mirroring
  `SUBAGENT_MAX_BACKGROUND`); a mid-exchange agent is never evicted.
  `session_shutdown` (quit/reload/new/resume/fork) disposes all — named agents
  are in-memory and session-scoped, with NO cross-restart live-session resume
  (the detach-manifest path remains the separate OS-subprocess story).
- Rejected alternatives: **journaled replay** ("resume" by re-running the
  record) — reimplements the workflow journal's hardest invariants for no
  benefit when the session is still alive; **keeping every agent forever** —
  unbounded memory; **per-exchange budgets** — an agent is exactly the thing
  you want a lifetime ceiling on (this is the aggregate-enforcement win, not a
  regression).

## Consequences

- Durable run records stay write-once — one per exchange, linked by `agentId`
  (the first exchange's toolCallId). The record store never learns about
  liveness.
- `name` is incompatible with `schema` (structured output is a one-shot
  capture contract) and with worktree isolation (the worktree is torn down
  when the first exchange returns; the session must outlive it). No transient
  retry — a retry needs a fresh session.
- `CoreAgent.run`'s create/dispose contract is untouched (38 test files depend
  on it); the shared `assembleSession()` extraction is a pure move.
- Follow-up routing (`send_message`), protocol messages, and team addressing
  build on the registry this decision creates — tickets 02–05 of the effort.
