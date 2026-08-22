---
effort: 2026-08-23-subagent-cc-parity-2
created: 2026-08-23
last: 2026-08-23
status: active
---

# subagent-cc-parity-2 — CC parity round 2: validate teams-parity, then fork / built-ins / startup-context / budget-directives / loop

## Destination

Teams-parity tickets 01–05 are proven in a live TUI session with a measured memory
curve for N live in-process child sessions. `spawn_subagent` then gains Claude
Code's fork mode (parent-context inheritance), Explore/Plan-style built-in
read-only agent types, and CC's startup-context block (git status + sibling roster
on top of the already-inherited CLAUDE.md hierarchy). `s2-agent-ext-ultracode`
gains CC's "+500k"-style budget directives (binding, not prose) and `/loop`
dynamic self-pacing via a `schedule_wakeup` tool. `spec.md` becomes the standing
Claude-Code-vs-s2 parity ledger — every parity ticket updates its tables in-PR.

## Context (measured 2026-08-23 on this machine, file:line verified during planning)

- **S1 — Fork is feasible through the extension's `sessionManager`, not through
  `WorkflowAgent`.** `ExtensionContext.sessionManager: ReadonlySessionManager`
  (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:219`)
  exposes `getEntries()/getLeafId()`; pi re-exports the compaction-aware
  projection helpers `buildContextEntries` + `sessionEntryToContextMessages`
  (`dist/index.d.ts:19`). `createAgentSession` has NO `initialMessages` option →
  a fork child cannot literally continue the parent session; it receives the
  parent transcript as prompt context. The `instructions` seam already composes
  in `subagent-tool-run.ts:432` (`WorkflowAgentOptions.instructions`).
- **S2 — Built-in read-only types have a clean building block.** pi exports
  `createReadOnlyTools` (`dist/core/sdk.d.ts`); `AgentDefinition.tools` is a
  plain name array (`s2-agent-core-runtime/src/agent-registry.ts:32-51`), and
  `disallowedTools` denylist beats allowlist in `applyToolPolicy`. Registry
  precedence today: project > pack > user (`agent-registry.ts` header);
  `resolveAgentType` at `agent-registry.ts:153`.
- **S3 — Startup context: children already inherit the CLAUDE.md hierarchy.**
  pi's `DefaultResourceLoader` loads `AGENTS.override.md, AGENTS.md, CLAUDE.md`
  candidates walking ancestors per cwd with worktree-shadowing handling
  (`dist/core/resource-loader.js:31-80`). The real gaps are a git-status
  snapshot and the sibling roster (`LiveAgentRegistry` is a process singleton
  in core-runtime). Footer composition order discipline lives at
  `subagent-tool-run.ts:459-463` (env-hints BEFORE abort-safety; abort-safety
  keeps the last word).
- **S4 — Budget directive: the forced-prompt transform is the parse point.**
  `workflow-editor.ts:518` returns `{action:"transform",
  text: buildForcedWorkflowPrompt(event.text, extra)}` on armed input;
  `run_workflow`'s `tokenBudget` threads `workflow-tool.ts:537/:566` →
  `workflow-manager.ts:175-188/510/555` as the documented hard run-wide cap.
  Today a "+500k" in the user message is NOT binding anywhere — only `/effort`
  prose nudges exist.
- **S5 — `/loop` + wakeup analogue has a proven wake primitive.**
  `pi.sendUserMessage(content, {deliverAs:"followUp"})` always triggers a turn
  (`dist/core/extensions/types.d.ts:302`). The 30s session-live cron loop starts
  at `extensions/ultracode.ts:289` (`startCronSchedulerLoop`); no `/loop`
  command or wakeup registry exists today (grep clean). Keyword arming:
  `DEFAULT_KEYWORD_TRIGGER_WORDS = ["workflow","ultracode"]`
  (`src/config.ts:34`).
- **S6 — Validation surfaces exist; memory is unmeasured.** TUI entry
  `./s2-agent.sh`; `/subagents` viewer (`subagents-command.ts` /
  `subagent-viewer.ts`); live roster on `list_subagent_runs list`
  (`subagent-runs-tool.ts`); protocol handshake covered unit-level only
  (`tests/protocol-messages.test.ts`). No `process.memoryUsage` probe exists
  anywhere in core-runtime/subagent src or tests (grep clean 2026-08-23).
- **Prior-effort facts carried:** dispatch choke point `child-dispatch.ts:124`;
  LRU cap `SUBAGENT_MAX_LIVE=6`; `parent-message-bus.ts` is the only
  child→parent channel (pi has no custom-message handler API); prior fog
  explicitly records "the TUI smoke of tickets 01-05 has not run in a live
  session" and "memory footprint of N live in-process sessions — STILL
  unmeasured" (teams-parity map, Fog of war).

## Tickets

Phase 1 — validation (gates the rest)
- `tickets/01-live-session-validation.md` — open — live-TUI smoke of
  teams-parity 01–05 surfaces + K=0..6 live-agent memory harness

Phase 2 — CC subagent parity (after 01)
- `tickets/02-fork-subagent.md` — open — `fork: true` prompt-borne parent-context
  inheritance; supersedes teams-parity D10
- `tickets/03-builtin-readonly-types.md` — open — `explore`/`plan` built-in
  fallback agent types (lowest-precedence tier)
- `tickets/04-startup-context.md` — open — git-status + sibling-roster startup
  block (after 02; reuses its transcript composer)

Phase 3 — ultracode parity (parallel with Phase 2)
- `tickets/05-budget-directive.md` — open — `+500k`-style binding token
  directive wired to run_workflow
- `tickets/06-loop-dynamic-pacing.md` — open — `/loop` command +
  `schedule_wakeup` self-pacing

Phase 4 — ledger hygiene
- `tickets/07-parity-ledger-reconciliations.md` — open — batch/singular
  display-model precedence unification + `agentType` minLength guard + spec.md
  sign-off

## Decisions

- D1: Validation before construction — tickets 02–04 do not start until 01's
  smoke session confirms addressability/roster/protocol live and records the
  memory curve; the fork transcript cap default depends on those numbers.
- D2 (supersedes teams-parity D10's fork exclusion): fork-type subagents ARE in
  scope this effort. Feasibility changed: pi exports `buildContextEntries` +
  `sessionEntryToContextMessages`, so a fork child receives the parent
  transcript as an instructions-prefix block (prompt-borne inheritance), NOT a
  literal session continuation — `createAgentSession` has no `initialMessages`.
  This is a deliberate divergence from CC recorded in spec.md §3, not silent
  parity.
- D3: Fork children are one-shot, background-DEFAULT (CC behavior), cannot
  spawn further forks (guard in the child's injected spawn tool), and cannot
  carry `name`.
- D4: Built-in agent types (`explore`, `plan`) resolve as the LOWEST-precedence
  tier (project > pack > user > builtin) so user files always win — the
  "definitions are user files" doctrine is preserved; built-ins ship as code in
  core-runtime (`source: "builtin"`), never written to disk, never merged when
  shadowed.
- D5: Startup context is a measured-gap fill, not a blanket port: first pin
  what the child system prompt already contains (resource-loader gives the
  CLAUDE.md hierarchy), then add git status + sibling roster as a task-prompt
  PREFIX block composing before env-hints and abort-safety footers; batch
  children share ONE git snapshot and get a size-capped block.
- D6: The budget directive is a HARD CEILING the model cannot lower: parsed
  from the user's message at the input-event transform seam
  (`workflow-editor.ts:518`), held in a session-level directive holder,
  applied as `max(directive, model-passed tokenBudget)` in `WorkflowManager`.
  `/effort` prose stays advisory; the directive is binding.
- D7: `schedule_wakeup` wakeups are in-memory and session-live (matching CC's
  session-scoped ScheduleWakeup); they do NOT enter `cron-store.ts`'s durable +
  cross-process-leased space; `/loop` survives only as long as the session —
  matching teams-parity D8 (no daemon).
- D8: `spec.md` is a maintained artifact of this effort: every parity ticket
  updates the alignment/divergence tables in its own PR.
- D9: Ticket 01's smoke findings (pass or fail) land in this map's Fog of war
  resolution, and the memory numbers land in spec.md §3 as s2-only evidence
  (in-process children vs CC's process-per-child).

## Frontier

Ticket 01 — it gates Phase 2 and produces the memory/size numbers that size the
fork transcript cap (D2) and validate the LRU default. Tickets 05/06 are
independent (ultracode-only) and may proceed in parallel with 01 if capacity
allows; they touch no file 01 observes.

## Fog of war

- Whether `sendUserMessage(followUp)` fired from the wakeup tick interleaves
  safely with an in-flight streaming turn (S5; ticket 06 must test with a fake
  session before trusting it live).
- Fork transcript token cost on long parent sessions — unresolved until 01
  measures real session sizes; mitigation is the compaction-aware projection +
  oldest-first char cap.
- Whether the `explore` built-in should skip the CLAUDE.md hierarchy like CC's
  Explore does (a per-call `resourceLoader` override is feasible via
  `WorkflowAgentOptions.session`) — decide in ticket 03/04 from measurements;
  otherwise record as accepted divergence.
- (carried from teams-parity ticket 07) batch-vs-singular display-model
  precedence divergence and empty-string `agentType` — closed by ticket 07.
- (carried) unnamed one-shot children keep the shared `send_message` instance;
  nested named children register into the process-global roster — documented
  non-fixes from ticket 05, unchanged here.

## Cross-effort links

Builds-on: 2026-08-22-subagent-teams-parity — consumes its 01–05 surfaces for
validation (ticket 01); SUPERSEDES its D10 (fork exclusion) via our D2;
inherits its fog items (TUI smoke, memory measurement, display-model
divergence) as tickets 01 and 07.
Builds-on: 2026-08-15-subagent-dynamic-budgets — D6's directive composes with
its role-aware envelopes (the directive bounds the RUN; the envelopes bound the
agent).
Shares-decision-with: 2026-08-22-ultracode-rename — tickets 05/06 touch the
package under its entry convention (`extensions/ultracode.ts`) and workflow
gate family.
