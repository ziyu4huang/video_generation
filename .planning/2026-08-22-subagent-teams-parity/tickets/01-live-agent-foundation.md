# Ticket 01 — live-agent-foundation

status: in-review

## Resolution (2026-08-22, branch feat/subagent-teams-parity)

Implemented. `LiveAgentRegistry` + `LiveAgent`/`openLiveAgent`/
`spawnLiveAgentFirstExchange` in core-runtime (session assembly shared via the
`CoreAgent.assembleSession()` extraction; `CoreAgent.run` contract untouched);
`spawn_subagent` `name` param with pre-flight validation; record fields
`agentName`/`agentId`; `session_shutdown` disposal in the extension entry;
CONTEXT.md doctrine rewritten + named-live-agent/live-agent-registry terms;
ADR-subagent-0008 + INDEX row. Tests: core-runtime `tests/live-agent-registry.test.ts`
(11) + `tests/persistent-agent.test.ts` (8, real guards over a fake session —
aggregate spend ceiling, timeout-leaves-session-reusable, steer branch);
subagent `tests/named-live-agent.test.ts` (6). One mechanical migration:
ultracode `tests/agent.test.ts` `lastAssistantText` moved from private-method
to the module-level export. Gates: core-runtime / subagent / ultracode full
`bun run test` + typecheck + biome green; s2-agent cross-package typecheck
green; ADR guard green. Manual TUI smoke still pending (no live session in
the authoring environment) — first user of `name:` should verify
addressability + `/subagents` display.

## Goal

Named child sessions survive completion: a process-singleton live-agent registry in
core-runtime, a persistent-agent runner, a `name` param on `spawn_subagent`, budget
aggregation across exchanges, and eviction. Rewrites the CONTEXT.md no-resume
doctrine; adds the effort's single ADR.

## Steps

1. NEW `bun-apps/s2-agent-core-runtime/src/live-agent-registry.ts` —
   `LiveAgentEntry` / `LiveAgentRegistry` / `getLiveAgentRegistry()` per spec §1
   (LRU `SUBAGENT_MAX_LIVE` default 6; evict least-recently-touched idle only;
   fail-fast with roster when all running; session-scoped reset/dispose).
2. Extract session assembly from `CoreAgent.run` (`agent.ts:230-366`) into a shared
   private helper used by both `run()` and the new `openLiveAgent()` — pure move.
3. NEW `bun-apps/s2-agent-core-runtime/src/persistent-agent.ts` —
   `openLiveAgent(opts)`, `LiveAgent.send(text)` (steer vs prompt branch,
   per-exchange timeout → abort), guards attached once at open, checked after each
   exchange against cumulative stats.
4. `subagent-tool-schema.ts` — add `name` (unique, `"main"` reserved).
5. `subagent-tool.ts` — on `name`: uniqueness/reserved failEarly; register into live
   registry after first exchange instead of `session.dispose()`; durable record gains
   `name` + `agentId` (records stay write-once, one per exchange).
6. `extensions/subagent.ts` — `session_shutdown` dispose-all, `session_start` reset.
7. Rewrite `CONTEXT.md` no-resume doctrine (:65) into two-mode vocabulary; document
   the singleton-sharing contract alongside the in-flight registry's.
8. NEW ADR `bun-apps/s2-agent-ext-subagent/docs/adr/0008-named-live-agents.md`
   (pointer line `**ID:** \`ADR-subagent-0008\`` per CLAUDE.md; update
   `bun-apps/docs/adr/INDEX.md`).

## Tests

- NEW core-runtime `src/live-agent-registry.test.ts` — singleton identity, LRU
  eviction, running-never-evicted fail-fast, session reset.
- NEW core-runtime `src/persistent-agent.test.ts` — fake session: steer-vs-prompt
  branch, cumulative budget abort across two exchanges, timeout abort leaves session
  reusable.
- Extend subagent `tests/subagent-tool*.test.ts` — name collision, reserved word,
  record fields, dispose-suppressed path.

## Acceptance

`bun run test` green in core-runtime AND s2-agent-ext-subagent; s2-agent cross-package
typecheck green; manual smoke (see map Destination): spawn named agent, verify it
stays addressable after completion.

## Risks

Session-assembly extraction touching the one-shot path (golden tests, pure move);
memory of live sessions (cap + smoke measurement); steer-to-running semantics pinned
by tests before ticket 02 builds on them.
