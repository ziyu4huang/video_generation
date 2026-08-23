# spec — s2-agent stack vs Claude Code: subagents, workflows, budgets, scheduling

Standing parity ledger for the multi-agent surface. Every parity ticket in this
effort updates §2/§3 in its own PR (map D8). Written 2026-08-23 from a
three-way study: local code exploration of `bun-apps/s2-agent-ext-subagent`,
`bun-apps/s2-agent-ext-ultracode`, `bun-apps/s2-agent-core-runtime`, and the
official Claude Code docs (§6).

## 1. Scope & sources

Our surfaces under comparison:

- `spawn_subagent` / `list_subagent_runs` (list/get/wait/stop + live roster) /
  `list_subagents` (batch) / `send_message` / `task_create|get|list|update` /
  child-injected `request_plan_approval` — `s2-agent-ext-subagent`
- `run_workflow` + vm globals (`agent/parallel/pipeline/workflow/verify/
  judgePanel/loopUntilDry/completenessCheck/retry/gate/checkpoint/call/log/
  phase/args/budget`) / `workflow_control` / `cron_create|list|delete` —
  `s2-agent-ext-ultracode`
- Shared machinery — `@repo/s2-agent-core-runtime` (`WorkflowAgent`,
  `LiveAgentRegistry`, `AgentRegistry`, `TeamTaskStore`, worktree helpers)

CC surfaces: Agent tool + subagents, agent teams, dynamic workflows
("ultracode"), scheduled tasks (CronCreate / `/loop` + dynamic mode).

## 2. Alignment table

CC feature | s2 equivalent | status | ticket
---|---|---|---
`.claude/agents/*.md` definition files (frontmatter name/description/tools/model) | `.pi/agents/*.md` (`agent-registry.ts`), CC-compatible incl. comma-separated tool lists | aligned | —
frontmatter `permissionMode` / `maxTurns` / `skills` / `effort` | `tools`/`disallowedTools`/`model`/`tier` only | partial | —
`isolation: worktree` | `createWorktree` per dispatch (singular tool only) | aligned | —
built-in Explore / Plan / general-purpose types | none shipped — user files only | gap | 03
subagent startup context (CLAUDE.md hierarchy + git status + sibling roster) | CLAUDE.md hierarchy via pi resource-loader; no git status, no roster | partial | 04
fork mode (inherit full parent conversation) | none (teams-parity D10 excluded it) | gap | 02
Agent-tool `name` param (addressable agent) | `name` on `spawn_subagent` → LiveAgent registry | aligned | —
follow-up messaging to live agents | `send_message` (steer when running, re-prompt when idle) | aligned | —
protocol envelopes `shutdown_request` / `plan_approval_request(_response)` | same envelope names, one `type`-union tool; timeout → DENY | aligned (verified live 2026-08-23, ticket 01 round 3; the child-side tool injection had been silently dead since pi 0.84.2 — fixed the same ticket via `readAllToolDefinitions`; live semantics: the child default-denies after its 5s window, so the parent must answer within it) | —
shared team task list | `TeamTaskStore` + `task_*` tools (session-scoped) | aligned | —
background execution | `background: true` (cap `SUBAGENT_MAX_BACKGROUND=4`, fail-fast) | aligned | —
per-invocation model override | `model`/`tier`/`capability` (precedence model > capability > tier > mainModel) | aligned | —
structured output (`schema`) | `schema` + `schemaRepairAttempts` | aligned | —
workflow JS script + `meta`/`phases` + `agent()/parallel()/pipeline()` | `run_workflow` script + same globals (+ `verify/judgePanel/loopUntilDry/completenessCheck/retry/gate/checkpoint/call`) | aligned | —
no fs/shell/module-load from the workflow script | vm sandbox, acorn-parsed meta, `Date.now`/`Math.random` banned | aligned | —
concurrency 16 / 1000 agents per run | same caps (plus shared per-provider rate limiter — ours adds provider-awareness) | aligned+ | —
resume via runId, longest-unchanged-prefix cache | disk journal + same prefix semantics, survives process restarts | aligned+ | —
budget directives ("+500k" → `budget.total` hard ceiling) | none binding — `/effort` prose only | gap | 05
`/deep-research` built-in workflow | `deep-research.ts` (Queries → Gather → Verify → Report) | aligned | —
"ultracode" arming keyword | `DEFAULT_KEYWORD_TRIGGER_WORDS = ["workflow","ultracode"]` | aligned | —
CronCreate 5-field cron, 7-day recurring expiry, session-live firing, missed fires skipped | `cron_create/list/delete` + session-live 30s loop, same contract | aligned | —
cron jitter / one-shot catch-up on session resume | no jitter; missed one-shots skipped by design | divergent | —
`/loop [interval] <prompt>` + dynamic self-pacing (`ScheduleWakeup` 60–3600s clamp, reason, stop) | none | gap | 06

"aligned+" = aligned with a strictly-additional s2 capability (see §4).

## 3. Deliberate divergences (keep, with rationale)

- **In-process children vs CC's process isolation.** Children are in-process
  Pi sessions (`WorkflowAgent` over `createAgentSession`), not OS subprocesses.
  Cheaper spawn, shared rate-limiter/registry singletons. Measured 2026-08-23
  (ticket 01 harness, `S2_MEM_PROBE=1 bun test
  tests/memory-live-agents.test.ts` in ext-subagent, faux transport so the
  numbers bound SESSION-OBJECT overhead only — tools, settings, subscriptions,
  one short transcript): K=1..6 live named agents cost ≈0.1–0.2MB marginal RSS
  each (+0.8MB total at the LRU cap of 6, on a ~151MB bun-test baseline);
  post-LRU-eviction RSS is flat while heapUsed holds steady — eviction frees
  the session object into GC, not the process footprint. Conclusion: at N=6
  the SESSION OBJECTS are noise; the real memory lever at scale is transcript
  size (real-model exchanges), which is what the fork transcript cap (D2,
  ticket 02) must bound. Fault isolation remains a standing divergence — a
  child crash still takes the process.
- **Fork = prompt-borne transcript, not session continuation (D2).** pi's
  `createAgentSession` has no `initialMessages`; a fork child gets the parent
  transcript as a compacted instructions-prefix block with a char cap. CC forks
  inherit the live conversation object.
- **Parent-brokered sibling messaging.** No direct child→child channel (pi has
  no custom-message handler API); siblings route through the parent with relay
  notifications. CC teams message via per-agent mailboxes.
- **Budget model.** Ours layers tier ceilings + role-aware envelopes + graceful
  wrap-up (from subagent-dynamic-budgets) UNDER any directive; CC is
  directives-only. Ticket 05 adds the directive as `max()` — the envelope
  machinery stays.
- **Cron durability.** Definitions durable on disk with cross-process `wx`
  fire-record leases, but firing is session-live (no daemon) — teams-parity D8.

## 4. s2-only advantages (no CC counterpart)

- Disk journal + longest-unchanged-prefix resume that survives process
  restarts; cross-process run leases with dead-pid sweep.
- `checkpoint()` journaled human-approval gates; `call()` deterministic
  zero-token host functions (`shell.run` + event-bus registry).
- Budget governance: tier ceilings, role-aware envelopes, graceful wrap-up
  turn, retry circuit-breaker, per-provider rate limiting shared across tools.
- Watchdog (L1 LSP / L2 model review), commit-scope audit, abort-safety footer
  discipline.
- Detach-to-OS-subprocess mid-run (`detach-run.ts`) with resume manifests.
- `/models-preset` tier routing; batch tool with per-task `agentType` binding.

## 5. Gap → ticket mapping

- fork → ticket 02 (supersedes teams-parity D10)
- built-in read-only types → ticket 03
- startup context (git status + roster) → ticket 04
- budget directives → ticket 05
- `/loop` + `schedule_wakeup` → ticket 06
- ledger hygiene (display-model precedence, `agentType` minLength, spec
  sign-off) → ticket 07
- live validation of everything above → ticket 01 (gates 02–04)

## 6. CC doc citations

- Subagents (frontmatter fields, built-in types, startup context, fork mode):
  https://code.claude.com/docs/en/sub-agents.md
- Agent tool (name param, run_in_background, per-invocation model, TaskOutput/
  TaskStop, SendMessage envelopes): https://code.claude.com/docs/en/tools-reference.md
- Agent teams (lead/teammates, task list, mailbox, protocol messages,
  limitations): https://code.claude.com/docs/en/agent-teams.md
- Dynamic workflows (script shape, 16/1000 caps, budget directives,
  /deep-research, sandbox restrictions): https://code.claude.com/docs/en/workflows.md
- Scheduled tasks (CronCreate contract, 7-day expiry, jitter, missed fires,
  one-shot restore, /loop dynamic + ScheduleWakeup clamps):
  https://code.claude.com/docs/en/scheduled-tasks.md
- Permission modes (subagent inheritance, frontmatter override):
  https://code.claude.com/docs/en/permission-modes.md

## 7. Maintenance rule

Any PR that adds or changes a multi-agent capability in
`s2-agent-ext-subagent`, `s2-agent-ext-ultracode`, or the shared core-runtime
agent machinery updates §2/§3 rows (and §4 when adding an s2-only capability)
in the same PR. New gaps get a ticket number here before they get code.
