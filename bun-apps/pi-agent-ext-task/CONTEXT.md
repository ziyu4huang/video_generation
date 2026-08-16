# pi-agent-ext-task

Also owns `ask_user_question` (merged from `pi-agent-ext-ask-user` on 2026-07-18 — see the "ask_user_question" section below). It shares no code or state with goal/todo; it was relocated here as the first step of a broader "ext-task pi-ext" consolidation, not because of a runtime coupling.

Also owns `/response-language` (relocated from its own `pi-agent-ext-response-language` package — see the "response-language" section below). It shares no code or state with goal/todo; relocated for ext-task pi-ext consolidation, not because of a runtime coupling. It pairs with the `force-response-language` patch in `pi-agent` (the per-turn injection half), coupling only through the `responseLanguage` key in `~/.pi/agent/settings.json`.

The ubiquitous language of pi-agent-ext-task — the `/goal` objective driver (with `goal_complete`) and the `todo` step tracker (with `/todos`), kept together because they share a composite status widget and six lifecycle hooks. Ported from @narumitw/pi-goal v0.11.0 (adapted for power-tool embedding). Publishes the `__piGoalActive` seam, read only by the in-package `/loop` subsystem (goal⇄loop mutual exclusion) and surfaced, display-only, by power-tool's `inspect_tui`; no plan coordinator or wayfind reads it.

## Language

### The composite widget

**Composite status widget** (`CoreTaskStatusWidget`, key `pi-core-task`):
A single below-editor widget rendering sections in fixed order: goal **or** loop (order 0, mutually exclusive) + todo (1) + wayfind (2). The goal and loop sections share order 0 because only one is ever non-empty at a time (goal⇄loop mutual exclusion). The plan-coordinator section (order 3) is documented but not currently registered. The reason goal+todo share a package — splitting them across two extensions reintroduces a widget-key ordering flicker (the SDK orders widgets by Map insertion with no index API).
_Avoid_: status bar, overlay (it is the composite widget keyed for deterministic stacking)

### Objective layer

**`/goal`**:
The command that drives one objective to completion within a session — owns iteration counting, token budget, and recovery. Published to the coordination seam while active.
_Avoid_: task, target (a goal is a session-scoped objective driven to done — distinct from a todo step or a plan phase)

**`goal_complete`**:
The tool that marks the active goal complete (only after all required work is verified). Blocked while the plan coordinator reports open phases.
_Avoid_: finish, done (it is the verified completion signal for `/goal`)

### Step layer

**`todo`**:
The in-session step tracker — fine-grained steps within a phase, branch-aware (replayed from the session branch). The bottom section of the composite widget.
_Avoid_: checklist, tasks (it is the in-session, branch-aware step tracker — see the plan coordinator's three-layer model)

**`/todos`**:
The command to view and manage the todo list.
_Avoid_: task list

**`/loop`**:
The command that runs a goal queue in a loop — executes goals sequentially, advancing the queue head after each completion. Mutually exclusive with `/goal` (only one active at a time, enforced by the `__piGoalActive` coordination seam). Uses `LoopState` to track the queue, parked items, and head advances. **Consumes** `__piKickHeartbeat` (published by `goal.ts`) to arm/disarm the heartbeat on its own start/stop transitions — `/loop` is the reader here, not the publisher.
_Avoid_: repeat, batch (it is a goal queue runner with explicit pause/resume and parking controls)

**`/list`**:
The command that inspects and manipulates the goal queue — shows the queue state, reorders items, parks/unparks goals, and removes entries. The queue layer for `/loop`, exposing the same underlying `LoopState`. Used during review to manage the pending goal sequence.
_Avoid_: show, display (it is a queue manipulation command, not just a viewer)

### Coordination

**Coordination seam** (`globalThis.__piGoalActive`):
The process-singleton reader ext-task publishes so the in-package `/loop` subsystem can detect an active goal WITHOUT a hard dep (goal⇄loop mutual exclusion). A peer reads `typeof __piGoalActive === "function" && __piGoalActive() === true`. ext-task is the publisher; only `/loop` (and power-tool's display-only `inspect_tui`) reads it — no plan coordinator or wayfind does.
_Avoid_: hook, signal (it is a published globalThis reader for cross-extension turn-ownership)

**Session-only todos**:
Todos are SESSION-ONLY in-memory state. `session_start` resets to `EMPTY_STATE` — never replayed from the session branch, never seeded from disk plans. `session_compact` / `session_tree` do NOT replay either (in-memory todos survive naturally). Permanent task tracking lives in wayfind/superpowers plans & tickets; the session todo is a transient working scratchpad.
_Avoid_: restore, persist, replay (todos are ephemeral session state, deliberately not reconstructed from history)

**Plan-coordinator asymmetry (L13)**:
The goal subsystem self-consumes the plan coordinator directly via internal calls (`planningGateBlocking()`, `planProgressLineFromPeer()`), while wayfind reads the same coordinator through published `__piPlan*` seams. This is intentional — goal needs immediate access to phase gating and progress, wayfind needs display-only coordination. The plan coordinator is a one-way publisher (ext-task → wayfind); there is no "yielding" behavior or bidirectional handshake.
_Avoid_: yield, handoff (it is a publish-consume pattern, not a state transfer)

**Published coordination seams** (ext-task → peers via `globalThis`):
Core-task publishes five coordination seams. Both intra-package seams are published by `goal.ts` and read by `/loop` — the publisher is goal in BOTH cases, never loop:
- **Goal-side (2):** `__piGoalActive` — `() => boolean` goal-activity reader; consumed by the in-package `/loop` subsystem (goal⇄loop mutual exclusion) and surfaced display-only by power-tool's `inspect_tui`. `__piKickHeartbeat` — `() => void` re-evaluate hook published at `goal.ts:935` and deleted on teardown at `goal.ts:695`; `/loop` calls it so a loop-only session can arm/disarm the heartbeat without a goal↔loop import cycle. Both are `crossPackage: false` in `core-interface/src/seam-keys.ts`.
- **Plan-side (3):** `__piPlanPhases`, `__piPlanIncomplete`, `__piPlanSummary` — `(cwd) => …` readers of the active plan, all consumed by wayfind.
All five are one-way publishes from ext-task; only wayfind (plan-side) and `/loop` (goal-side) read them.
_Avoid_: hook, signal (they are published globalThis readers, not event hooks)

**Process-singleton state**:
Todo/goal state are module-level singletons, safe under pi's native one-session-per-process lifecycle (sequential teardown→create). Known caveat: in-process subagents (`WorkflowAgent.run` → `createAgentSession`) share these singletons, causing cross-contamination — see ticket #16 for the hardening fix.
_Avoid_: global state, shared cell (the singleton is safe natively; the subagent path is the exception)

## Language — ask_user_question

The `ask_user_question` tool: a structured option selector with a free-text "Other" fallback. Extracted from power-tool; ported from @juicesharp/rpiv-ask-user-question.

**ask_user_question**:
The structured-choice tool — 1–4 questions, each with 2–4 options; the user picks one (or multi-selects), types a free-text answer, or abandons. The deterministic way to get a decision from the user mid-task.
_Avoid_: prompt, input (it is a structured multi-option selector, not a free prompt)

**Other fallback**:
The free-text escape hatch — every question auto-appends a "Type something." row so the user can always answer outside the offered options (or press Esc to abandon).
_Avoid_: custom input, free-text box (it is the auto-appended free-text fallback every question has)

**Reconciler** (`before_agent_start`):
Rewrites a pending `ask_user_question` tool call into the canonical question shape before the agent turn starts — so a malformed or model-shaped call still renders correctly.
_Avoid_: validator, normalizer (it is a pending-call canonicalization on `before_agent_start`)

## Language — response-language

The `/response-language` command (relocated from its own package): live control of the agent's reply language. Self-contained — no shared widget, hooks, or state with goal/todo/ask-user.

**`/response-language`**:
The command that shows or sets `responseLanguage` in `~/.pi/agent/settings.json`. No arg shows the current value; a BCP-47 tag sets it; invalid input is rejected. Setting it just writes the key — no prompt reload — because the paired patch re-reads settings on the next turn, so the next reply already uses the new language.
_Avoid_: locale switch, i18n toggle (it is a settings-key setter that drives the forced-injection patch, not a translation layer)

**Forced-injection pair** (`force-response-language` patch in `pi-agent`):
The other half of the feature — lives in `pi-agent/src/patches/` because it wraps `AgentSession.prototype._installAgentNextTurnRefresh` to prepend a forced `<response_language>` block to every turn's system prompt, reading `settings.json` fresh each turn. The command writes the key; the patch re-reads it on the next turn (no reload needed). That cross-package coupling through `settings.json` is the whole integration.
_Avoid_: language enforcer, prompt builder (it is a per-turn system-prompt patch paired with this command, owned by pi-agent)
