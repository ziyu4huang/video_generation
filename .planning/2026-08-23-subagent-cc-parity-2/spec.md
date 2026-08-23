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
built-in Explore / Plan / general-purpose types | `explore`/`plan` built-ins (`builtin-agents.ts`, ticket 03): code-only lowest-precedence tier (project > pack > user > builtin), read-only via the `createReadOnlyTools` allowlist (read/grep/find/ls) + explicit `edit`/`write`/`bash` denylist, any user file shadows completely; general-purpose deliberately NOT shipped (the default no-agentType dispatch already is it) | aligned with a deliberate divergence (§3) | 03
subagent startup context (CLAUDE.md hierarchy + git status + sibling roster) | CLAUDE.md hierarchy via pi resource-loader (pinned 2026-08-23 by a faux-transport measurement test: root AND ancestor CLAUDE.md land in the child's system prompt, `tests/startup-context.test.ts`); `context: "full"\|"minimal"\|"none"` param prefixes a spawn-time git snapshot (branch/HEAD/porcelain, line- and char-capped) + sibling roster (live agents first, then non-terminal one-shots, ≤12 rows) as a task PREFIX composing before env-hints and abort-safety. Singular default `full`; batch default `minimal` with ONE shared snapshot per `list_subagents` call (every child sees identical spawn-time state, tighter 1k cap) | aligned | 04
fork mode (inherit full parent conversation) | `fork: true` on `spawn_subagent`: compaction-aware transcript block (24k-char default cap, `SUBAGENT_FORK_TRANSCRIPT_CAP` env, oldest-first truncation), background by default, one level deep (ambient fork-child scope rejects nested forks) | aligned with a deliberate divergence (§3) | 02
Agent-tool `name` param (addressable agent) | `name` on `spawn_subagent` → LiveAgent registry | aligned | —
follow-up messaging to live agents | `send_message` (steer when running, re-prompt when idle) | aligned | —
protocol envelopes `shutdown_request` / `plan_approval_request(_response)` | same envelope names, one `type`-union tool; timeout → DENY | aligned (verified live 2026-08-23, ticket 01 round 3; the child-side tool injection had been silently dead since pi 0.84.2 — fixed the same ticket via `readAllToolDefinitions`; live semantics: the child default-denies after its 5s window, so the parent must answer within it) | —
shared team task list | `TeamTaskStore` + `task_*` tools (session-scoped) | aligned | —
background execution | `background: true` (cap `SUBAGENT_MAX_BACKGROUND=4`, fail-fast) | aligned | —
per-invocation model override | `model`/`tier`/`capability` (precedence model > capability > tier > mainModel; ONE shared display resolver `resolveDisplayModel` on the singular in-flight string, the batch result slots, AND the singular background track record — prefixed strings `tier:x`/`capability:y` everywhere; `agentType: ""` is a bad type name on both tools, schema `minLength: 1` + runtime `!== undefined` guards, never silently "untyped") | aligned | 07
structured output (`schema`) | `schema` + `schemaRepairAttempts` | aligned | —
workflow JS script + `meta`/`phases` + `agent()/parallel()/pipeline()` | `run_workflow` script + same globals (+ `verify/judgePanel/loopUntilDry/completenessCheck/retry/gate/checkpoint/call`) | aligned | —
no fs/shell/module-load from the workflow script | vm sandbox, acorn-parsed meta, `Date.now`/`Math.random` banned | aligned | —
concurrency 16 / 1000 agents per run | same caps (plus shared per-provider rate limiter — ours adds provider-awareness) | aligned+ | —
resume via runId, longest-unchanged-prefix cache | disk journal + same prefix semantics, survives process restarts | aligned+ | —
budget directives ("+500k" → `budget.total` hard ceiling) | parsed at the workflows-mode input transform (`budget-directive.ts`), held session-level (read-and-clear — one directive binds exactly one armed-message run, cleared when an armed message carries none, reset on session_start), enforced at every WorkflowManager run entry as `max(directive, model-passed tokenBudget)` with a persisted `tokenBudgetSource` label ("directive"/"model"/"merged") on the run record + display header; cron fires excluded by design (their budget comes from the script); headless `-p` parity VERIFIED 2026-08-23 (ticket 02 of `.planning/2026-08-23-headless-dispatch-hang/`): print-mode prompts default to input-source "interactive" so the same transform arms headless — pinned by `s2-agent-ext-ultracode/tests/headless-arming-parity.test.ts` and measured live (run `mt5q0urv-9hdejl`: `tokenBudgetSource: "merged"`); the arming gate that actually matters is `keywordTriggerEnabled` in the workflow settings (this machine's global file has it `false` — arming-by-keyword is off interactively too) | aligned | 05
`/deep-research` built-in workflow | `deep-research.ts` (Queries → Gather → Verify → Report) | aligned | —
"ultracode" arming keyword | `DEFAULT_KEYWORD_TRIGGER_WORDS = ["workflow","ultracode"]` | aligned | —
CronCreate 5-field cron, 7-day recurring expiry, session-live firing, missed fires skipped | `cron_create/list/delete` + session-live 30s loop, same contract | aligned | —
cron jitter / one-shot catch-up on session resume | no jitter; missed one-shots skipped by design | divergent | —
`/loop [interval] <prompt>` + dynamic self-pacing (`ScheduleWakeup` 60–3600s clamp, reason, stop) | `/loop [30s\|5m\|1h\|default 10m] <prompt>` (fixed cadence), `/loop dynamic <prompt>` (model-paced), `/loop off`; `schedule_wakeup` tool (delaySeconds clamped 60–3600 with a loud message, required reason, optional stop, cache-window-aware pacing guidance) re-fires the ORIGINAL prompt + a loop footer (id, fire N/cap, last reason) into the session via `sendUserMessage(followUp)` — queued while a turn streams, drained as the next turn (pinned end-to-end with a real AgentSession over a faux transport, `tests/wakeup-interleave.test.ts`); in-memory session-live registry (map D7 — never in the durable cron store, no daemon), max 1 pending wakeup per loop id, fire cap 50/loop with an auto-stop notification | aligned (s2 adds the fire cap + the footer's fixed/dynamic split) | 06

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
  transcript (`buildForkTranscript`: compaction-aware, user/assistant text +
  latest compaction summary only, 24k-char default cap with oldest-first
  truncation) as a `## Parent conversation (context only, do not continue it)`
  instructions-prefix block. CC forks inherit the live conversation object.
  Shipped ticket 02: background by default, no `name`/`agentType`, one level
  deep (nested forks rejected via the ambient fork-child scope), and a missing
  transcript source fails pre-flight rather than inheriting nothing silently.
- **Built-in read-only types keep the full CLAUDE.md hierarchy (ticket 03).**
  CC's Explore skips repo context files for lean prompts; our `explore`/`plan`
  built-ins ride the standard resource-loader (CLAUDE.md/AGENTS.md inherited
  like any child). No per-call `resourceLoader` override was shipped — the
  read-only allowlist is the safety boundary, and repo context helps rather
  than hurts local exploration. Revisit only if a measurement shows bloat
  (fog item tracked in the map).
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

## 8. Sign-off (ticket 07 final pass, 2026-08-23)

- Every ticket 01–07 has its §2/§3 rows confirmed updated in its own PR (D8);
  the two ledger fogs carried from teams-parity ticket 07 — batch-vs-singular
  display-model precedence and empty-string `agentType` — are closed in §2's
  model-override row (shared `resolveDisplayModel`, model > capability >
  tier > mainModel, prefixed display strings; `minLength: 1` + runtime
  `!== undefined` guards on both tools).
- §3 divergence table reviewed 2026-08-23: every entry is a deliberate,
  rationale-carrying divergence — none is an unowned accident.
- §6 CC citations re-checked 2026-08-23 (docs studied the same day the spec
  was written; all six surfaces still match the shipped behavior).
- The batch display change is observable, not just internal: result-slot
  `model` strings that previously rendered a raw tier (`big`) now render
  `tier:big`, and capability beats tier where both are set — pinned by
  `tests/display-model-parity.test.ts` (matrix + both-tool agentType guards).

## 9. Live smoke (2026-08-23, post-close-out batch)

One headless `./s2-agent.sh -p` dispatch per surface, model
`deepseek/deepseek-v4-flash`, worktree branch `subagent-live-smoke-batch` @
452513a9. Full evidence matrix: `.planning/2026-08-23-headless-dispatch-hang/map.md`.

| Surface | Live result |
|---|---|
| fork (`fork: true`, background, transcript inheritance) | PASS — child inherited the parent transcript and summarized it correctly, background + `list_subagent_runs` wait-poll relayed the reply, clean exit 21s |
| built-in `explore` / `plan` | PASS — `explore` used its read-only tools and returned a verified count (25 `.ts` files, cross-checked); `plan` returned `PLAN-OK`; both types accepted (no `agentType` guard false-rejects) |
| startup context (`context: "full"`) | PASS — child reported `GITCTX-OK subagent-live-smoke-batch`: the git snapshot block landed with the correct branch name |
| budget directive (`+500k`) | NEGATIVE **RE-DIAGNOSED 2026-08-23 evening (ticket 02, closed)** — the run completed (34,019 tok) with no `tokenBudgetSource`, but NOT because headless `-p` is source-gated: print-mode prompts default to input-source "interactive", so the arming guard passes headless. The actual cause was `keywordTriggerEnabled: false` in this machine's global `~/.pi/workflows/settings.json` (keyword arming off everywhere, interactive included). A/B measured live in a scratch project with the trigger enabled per-project: trigger off → no transform, run `mt5pwx3c-30sjnp` persists `tokenBudgetSource: "model"` (the model improvised `tokenBudget: 500000` from the raw text); trigger on → forced-workflow transform fires headless (`[workflows mode is ON …]` preamble in the transcript), run `mt5q0urv-9hdejl` persists `tokenBudget: 500000, tokenBudgetSource: "merged"`. Parity pinned by `tests/headless-arming-parity.test.ts`. Full write-up: `.planning/2026-08-23-headless-dispatch-hang/tickets/02-*.md` |
| `/loop` dynamic (`schedule_wakeup`) | BLOCKED — the dispatch hung pre-send (B1: content-keyed headless pre-request hang, reproducible in bare mode; zero events, 0% CPU, no sockets). Ticketed: `tickets/01-*.md` |

Incidental: one run lingered ≥114s after `agent_settled` (B3, unreproduced —
m1–m4 all settled-AND-exited in 20–34s); recorded as fog in the hang effort.
