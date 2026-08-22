---
effort: 2026-08-22-subagent-teams-parity
created: 2026-08-22
last: 2026-08-22
status: active
---


# subagent-teams-parity — close the remaining Claude Code subagent / agent-teams gaps

## Destination

`s2-agent-ext-subagent` gains Claude Code's agent-teams core: named live agents that
survive completion and accept follow-up messages (`send_message`), a shared
cross-agent task list, protocol messages (shutdown / plan-approval handshake), and
parent-brokered teammate addressing — with the existing budget governance intact and
now aggregated across an agent's whole lifetime. `s2-agent-ext-ultracode` closes its
three small gaps: `manifest.model` on the tool path, `agentType` on the batch tool,
and session-live cron scheduling for workflows.

## Context (measured 2026-08-22 on this machine, verified file:line during planning)

- **pi sessions are multi-turn reusable.**
  `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts`:
  `prompt(text, options?)` (:355, second prompt after completion is ordinary use),
  `steer(text)` (:371, queues while running), `isStreaming` (:291), `abort()` keeps the
  session usable (:433), `dispose()` (:283), `getSessionStats()` cumulative over the
  session lifetime (:615).
- **The current run path is strictly one-shot.**
  `bun-apps/s2-agent-core-runtime/src/agent.ts`: single `session.prompt` at :435,
  `session.dispose()` in the `finally` at :523. 38 subagent test files depend on this
  create/dispose contract.
- **Budgets aggregate for free on a persistent session.**
  `agent-budget.ts:99-109` polls cumulative `getSessionStats()`; the turn guard counts
  `turn_end` events on the session. One session + one guard held for the agent's
  lifetime = per-agent aggregate enforcement across re-prompts.
- **The parent-wake seam is proven.** `background-run-manager.ts:160-182`:
  `pi.sendMessage(msg, {deliverAs:"followUp", triggerTurn:true})` — `triggerTurn:true`
  is what wakes an IDLE parent (PR #1800).
- **Tool injection into children already exists.**
  `WorkflowAgentOptions.extensionTools` (`agent.ts:41-47`); the subagent extension
  captures parent tools at `session_start` (`extensions/subagent.ts:41-44`); the
  ultracode manager threads the same (`workflow-manager.ts:154-158`). Registering once
  in the parent reaches spawn children AND workflow `agent()` children.
- **pi has NO custom-message handler API** (grep over `types.d.ts` is empty) → child→parent
  messaging must be brokered through a process-singleton bus; there is no direct
  child→child channel. Children are in-process (`agent.ts:43-46`).
- **The no-resume doctrine is explicit.** subagent `CONTEXT.md:65`: "a subagent run is
  a one-shot dispatch with NO resume semantics" — ticket 01 rewrites it.
- **P4 seams pre-charted.** `workflow-tool.ts:439-441`/`:507-513` keeps
  `manifest.model` out of exec options ("see #630, OOS"); `WorkflowManager.mainModel`
  already exists (`workflow-manager.ts:323-325`). Batch tool has no `agentType`
  (`subagents-tool.ts:50`); `resolveAgentType` at `agent-registry.ts:153`. No cron
  anywhere in ultracode src (grep clean). No `send_message`/`task_*`/`cron_*` tool
  names collide across exts.
- **ext-task is NOT the task-list owner.** Its CONTEXT scopes it to `/goal`,
  session-only todos, `ask_user_question` — permanent tracking lives in
  wayfind/superpowers. The teams task list is a new ubiquitous-language term.

## Tickets

Phase 1 — foundation (P1)
- `tickets/01-live-agent-foundation.md` — closed 2026-08-22 (PR #1809 → main 6147264,
  closed by #1810) — live-agent registry + persistent agent runner + `name` param +
  doctrine rewrite + ADR-subagent-0008
- `tickets/02-send-message-surface.md` — closed 2026-08-22 (PR #1818 → main
  351fc22e) — `send_message` tool, name/agentId routing, `to:"main"` broker bus

Phase 2 — shared state (P2)
- `tickets/03-shared-task-list.md` — closed 2026-08-22 (PR #1824 → main
  132a0622) — `task_create/get/list/update` over a session-scoped in-memory
  `TeamTaskStore`; review findings fixed (atomic create-unwind, atomic update
  edge rollback) and re-approved

Phase 3 — teams vocabulary (P3)
- `tickets/04-protocol-messages.md` — closed 2026-08-22 (PR #1829 → main
  5e8eef5d) — `send_message` type envelopes + child-injected
  `request_plan_approval` over core-runtime's `PendingProtocolMap` (timeout →
  DENY per D6); two-stage shutdown; stop-by-name; detach refusal. Review
  findings fixed (M1 allowlist guard, M2 manual round-trip, m1/m2 shutdown)
  and merged APPROVE-WITH-FIXES
- `tickets/05-team-addressing.md` — closed 2026-08-22 (PR #1834 → main
  1d37ec7d) — parent-brokered sibling routing (selfName-stamped child
  `send_message` instance; relay + deliver, both-see-it) + live team roster on
  `list_subagent_runs list`; child protocol envelopes at teammates refused.
  Reviewer APPROVE, 4 minors fixed pre-merge (running-branch race, relay
  ordering, throwing steer, unpinned guards)

Phase 4 — ultracode gaps (P4)
- `tickets/06-manifest-model-tool-path.md` — task — `ExecOptions.mainModel` hook,
  precedence script > manifest > session
- `tickets/07-batch-agent-type.md` — task — per-task `agentType` on `list_subagents`
- `tickets/08-workflow-cron.md` — task — `cron_create/list/delete`, session-live
  firing, lease-guarded, 7-day recurring expiry

## Decisions

- D1: Registry and runner live in `@repo/s2-agent-core-runtime` (same reasoning as the
  in-flight registry: ultracode + obsidian peers need them without ext→ext edges;
  barrel facade rule covers re-exports).
- D2: `CoreAgent.run`'s one-shot create/dispose contract is NOT modified — session
  assembly is extracted into a shared helper used by both paths, so they cannot drift
  (the hand-alignment failure mode `child-dispatch.ts:10-19` records).
- D3: Budget/turn guards attach once at agent open and check cumulative session stats —
  per-agent lifetime aggregation; `timeoutMs` applies per exchange.
- D4: Eviction is env-capped LRU (`SUBAGENT_MAX_LIVE`, default 6, mirroring
  `SUBAGENT_MAX_BACKGROUND=4`); `session_shutdown` disposes everything; durable run
  records stay write-once, one per exchange, linked by `agentId`.
- D5: Named agents are in-memory, scoped to the parent session — no cross-restart
  live-session resume (the detach manifest path covers OS-subprocess persistence).
- D6 (user): plan_approval timeout defaults to DENY (budget-safe; never block a
  dispatch forever).
- D7 (user): batch (`list_subagents`) does NOT gain `name` — persistent agents are
  spawn_subagent-only.
- D8 (user): cron definitions are durable but firing is session-live — no daemon; the
  existing cross-process run leases guard against double-fire.
- D9: Task list tools register in the subagent ext (existing `extensionTools` bridges
  reach children and workflow agents with zero dispatch-path changes);
  `s2-agent.registry.yaml` unchanged — no new ext for any ticket.
- D10: Out of scope: fork-type subagents, remote isolation, ToolSearch/skills-in-child,
  cross-restart live-session resume, direct child→child channels, a cron daemon.
- D11 (ticket 04): `request_plan_approval` is CHILD-INJECTED, never
  parent-registered — the parent never asks its own parent for approval, so the
  tool joins neither the active set nor the workflow gate family. Children get
  it via the extensionTools bridge plus a named-dispatch allowlist append
  (guarded: only onto a NON-EMPTY list — an absent/empty list means no
  restriction, and appending there would strip every other tool; review M1).
- D12 (ticket 04): the MANUAL `send_message plan_approval_request` path (agents
  without the injected tool) holds NOTHING — its reply is a plain send_message;
  the envelope-typed `plan_approval_response` resolves only the tool's pending
  hold (review M2). Detached-resume subprocesses refuse every protocol surface
  (`SUBAGENT_DETACHED_RESUME` env marker; the bus stays unwired there).

## Frontier

`tickets/06-manifest-model-tool-path.md` — the teams core (tickets 01-05) is
whole: addressability, shared state, protocol, and team addressing are all
merged and unit-pinned. Phase 4 starts with the smallest seam: `ExecOptions.
mainModel` on `workflow-manager.ts`, a hook pre-charted at
`workflow-tool.ts:439-441` ("see #630, OOS") with the precedence already
decided (script > manifest > session).

## Fog of war

- ~~steer() deadlock surface under an awaiting parent~~ — resolved ticket 02:
  in-process loops are distinct; send_message to a running agent steers and returns
  immediately (tests/send-message-tool.test.ts t4, t6).
- ~~whether steer() resolves the awaited dispatch early~~ — resolved ticket 01:
  the awaited tool call resolves at exchange end; the steer only joins the queue
  (persistent-agent tests + ADR-subagent-0008).
- Memory footprint of N live in-process sessions under the LRU cap — STILL unmeasured;
  the TUI smoke of tickets 01-05 has not run in a live session (no live-session
  environment during any ticket). First `name:` + `send_message` use should
  confirm addressability, `/subagents` display, and rough memory.
- Ticket 05 residual seams (documented non-fixes): sender identity is only as
  trustworthy as the stamp — an unnamed one-shot child keeps the SHARED
  send_message instance (no selfName), so its teammate sends behave like
  parent sends (unbrokered); a named child cannot lie about its name, but a
  nested child spawning its own named child registers into the same
  process-global roster (roster shows all; relays all surface to the root).
- Cron `lastMissed` surfacing (ticket 08 optional polish) — undecided.

## Cross-effort links

Builds-on: 2026-08-15-subagent-dynamic-budgets — its role-aware envelopes and tier
defaults become the per-agent-lifetime aggregates enforced by the persistent guards
(D3); its "paused" fog items are untouched by this effort.
Shares-decision-with: 2026-08-22-ultracode-rename — ticket 06/08 touch the package
under its new name and entry convention (`extensions/ultracode.ts`).
