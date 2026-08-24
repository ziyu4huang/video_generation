# Spec — subagent-teams-parity

Design source: planning session 2026-08-22 (exploration of both exts + core-runtime +
pi typings; assumptions verified file:line, listed in map.md Context). The plan text
below is the executable design; tickets carry per-PR scope.

## 1. Live-agent foundation (tickets 01–02)

### LiveAgentRegistry (`core-runtime/src/live-agent-registry.ts`, NEW)

Process-singleton via module-local lazy getter, mirroring the `subagent-in-flight.ts:283`
idiom. Entry:

```ts
type LiveAgentEntry = {
  name: string;              // unique among live agents; "main" reserved
  agentId: string;           // links durable run records (one record per exchange)
  sessionId: string;         // owning parent session
  session: AgentSession;     // the persistent pi session
  model: string; cwd: string; agentType?: string;
  status: "running" | "idle";
  openedAt: number; lastTouchedAt: number;  // LRU clock
  budgetGuard: BudgetGuard; turnGuard: TurnGuard;  // attached once at open
  abort(): Promise<void>;
  dispose(): void;           // dispose session, free name, keep durable records
  stats(): SessionStats;     // cumulative = aggregate enforcement
};
```

Eviction: LRU capped by `SUBAGENT_MAX_LIVE` (default 6). Registering beyond the cap
evicts the least-recently-touched IDLE entry (never a running one; if all are running,
fail-fast with the live roster, mirroring `SUBAGENT_MAX_BACKGROUND` fail-fast).
`session_shutdown` disposes all entries for the session; `session_start` resets.

### Persistent agent (`core-runtime/src/persistent-agent.ts`, NEW)

- `openLiveAgent(opts)` assembles a session via a NEW shared private helper
  `assembleSession()` extracted from `CoreAgent.run` (`agent.ts:230-366` model
  resolution + customTools assembly). `CoreAgent.run`'s one-shot path calls the same
  helper — pure move, no behavior change (D2).
- `LiveAgent.send(text)`: if `session.isStreaming` → `session.steer(text)`; else →
  `session.prompt(text)` under a per-exchange `timeoutMs` timer calling
  `session.abort()` (abort ends the loop; the session stays reusable). Guards are
  checked after each exchange against cumulative stats (D3).
- Budget/turn guards subscribe once at open and live for the agent's lifetime.

### spawn_subagent `name` param (ticket 01)

- Schema: `name: Type.Optional(Type.String())` — "Stable handle for later
  send_message dispatches; unique among live agents; 'main' is reserved."
- `subagent-tool.ts`: on `name` present — uniqueness + reserved-word check (failEarly
  with detail, `:122-134` idiom); after the first exchange completes, register the
  session in the live registry INSTEAD of `session.dispose()`. Durable run record
  gains `name` + `agentId` fields; records stay write-once, one per exchange.
- `extensions/subagent.ts`: wire `session_shutdown` (dispose all for this session) and
  `session_start` (reset).

### send_message tool (ticket 02)

Schema `{ to: string, message: string, wait?: boolean, timeoutMs?: number }`
(extended in ticket 04 with a `type` envelope). Execution:

- Resolve `to` by name, then agentId, in the live registry. Unknown → error listing
  live names.
- Running (`isStreaming`) → `send()` as steer; return "delivered, agent is mid-flight".
- Idle → `send()`; `wait:true` blocks on the exchange via the 250 ms poll idiom
  (`subagent-runs-tool.ts:225-250`); `wait:false` returns immediately, completion
  delivered as a task notification through the existing BackgroundRunManager deliverer
  (`formatTaskNotification` reuse).
- Child-side `to === "main"`: routes to a process-singleton `ParentMessageBus` whose
  deliverer the extension entry wires with
  `pi.sendMessage(msg, {deliverAs:"followUp", triggerTurn:true})` — the proven wake
  seam.
- The tool registers in the parent AND reaches children via `extensionTools`; it is
  added to the batch tool's read-only-safe set (read-only children keep it).

Naming: dedicated tool over extending `list_subagent_runs` (the runs tool is
read-oriented list/get/wait/stop; mutating actions get their own verb_object tool).

## 2. Shared task list (ticket 03)

- `core-runtime/src/team-task-store.ts` (NEW): process-singleton `TeamTaskStore`
  keyed by parent sessionId; IN-MEMORY only (reset on session_start, dropped on
  session_shutdown). Task: `{ id, subject, description, activeForm?, status:
  pending|in_progress|completed, owner?: agentName|"main", blocks: id[], blockedBy:
  id[], metadata?, createdAt, updatedAt }`. Dependency edges validated with cycle
  rejection.
- `s2-agent-ext-subagent/src/task-tools.ts` (NEW): `task_create` / `task_get` /
  `task_list` / `task_update` — thin adapters; pure logic stays in core-runtime.
- Registered in the subagent ext; children and workflow agents receive them through
  the existing `extensionTools` bridges with zero dispatch-path changes (D9). Added to
  the read-only-safe set.
- In-memory over `~/.pi` persistence: team task lists are session-scoped; permanent
  tracking already lives in wayfind (ext-task CONTEXT). The in-process singleton
  sharing that is a contamination bug for ext-task todos is exactly the feature here.

## 3. Protocol messages + team addressing (tickets 04–05)

- `send_message` gains `type?: "shutdown_request" | "shutdown_response" |
  "plan_approval_request" | "plan_approval_response"` plus `approve?`, `feedback?` on
  responses.
- **plan approval**: a child's injected `request_plan_approval` tool returns a Promise
  stored in the registry's pending-protocol map; the parent is notified via followUp;
  `send_message {type:"plan_approval_response", approve}` resolves it. Timeout
  defaults to DENY (D6). In-process path only — the detach subprocess path refuses.
- **shutdown_request** parent→child: steer text + grace timer → `abort()` (two-stage,
  mirroring `BUDGET_WRAP_UP_MESSAGE` at `agent-budget.ts:141`). Child→parent:
  notification only; the parent approves by stopping (`list_subagent_runs stop`
  gains name-based lookup).
- **Sibling addressing**: a child's message to a sibling named agent is parent-brokered
  — delivered into the target's steer queue AND surfaced to the parent as a followUp
  notification (both see it). No direct child→child channel. Roster:
  `list_subagent_runs` `list` action gains a `live` section.

## 4. ultracode gaps (tickets 06–08)

- **manifest.model**: `ExecOptions.mainModel?: string` on `workflow-manager.ts` (:103),
  threaded ahead of the manager-level `mainModel` in the runtime's modelSpec resolution
  (`workflow-runtime.ts:265-270`); `workflow-tool.ts:507-513` passes
  `resolved.manifest?.model`. Precedence: script per-agent `model` > `manifest.model`
  > session mainModel. `toPersistedExec` serializes the new field. PRD.md:74-76
  updated.
- **batch agentType**: per-task `agentType` on `subagents-tool.ts`, resolved via
  `resolveAgentType` (`agent-registry.ts:153`) exactly as the singular path
  (`subagent-tool.ts:138-149`) including unknown-type failEarly. Read-only exclusion
  stays non-overridable; worktree-isolating agentTypes are REJECTED in batch with a
  clear message.
- **cron**: `cron-scheduler.ts` (pure 5-field cron next-fire math incl. month/DOW OR
  semantics, one-shot vs recurring, 7-day recurring expiry) + `cron-store.ts` (durable
  definitions under the ultracode state root; fire-records lease-claimed before
  dispatch so two live sessions never double-fire). Tools `cron_create` / `cron_list`
  / `cron_delete`; a 30 s interval loop at session_start fires
  `WorkflowManager.startInBackground`, stopped at session_shutdown. Firing is
  session-live only (D8) — documented limitation, no daemon.

## Testing strategy

All new tests are unit-level with injected fakes (fake session exposing
`prompt/steer/isStreaming/abort/getSessionStats/dispose`; fake runner seams as in
`tests/child-dispatch.test.ts`). No live LLM calls. Each ticket's PR runs its
package's full `bun run test` gate; core-runtime changes additionally run the
s2-agent cross-package typecheck. local_ci ≤ 5 min (standing user rule).

## Documentation

- subagent CONTEXT.md: ticket 01 rewrites the one-shot doctrine (:65) into two-mode
  vocabulary (one-shot dispatch vs named live agent); tickets 02-05 add terms
  (`send_message`, `named agent`, `live-agent registry`, `team task list`, `protocol
  message`, `plan approval`, `shutdown handshake`, `team` / `teammate` / `brokered
  routing`) each with `_Avoid_` lines.
- Exactly ONE ADR (ticket 01): named live agents — in-process session retention +
  aggregate budgets is hard to reverse, surprising without context, and a real
  trade-off. Everything else is map.md Decisions.
- ultracode CONTEXT.md: cron terms (ticket 08). PRD.md:74-76 rewrite (ticket 06).
- Registry (`the registry YAML`) unchanged throughout (D9).
