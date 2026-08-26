# s2-agent-ext-task

Also owns `ask_user_question` (merged from `s2-agent-ext-ask-user` on 2026-07-18 — see the "ask_user_question" section below). It shares no code or state with goal/todo; it was relocated here as the first step of a broader "ext-task pi-ext" consolidation, not because of a runtime coupling.

Also owns `/response-language` (relocated from its own `s2-agent-ext-response-language` package — see the "response-language" section below). It shares no code or state with goal/todo; relocated for ext-task pi-ext consolidation, not because of a runtime coupling. It pairs with the `force-response-language` patch in `s2-agent` (the per-turn injection half), coupling only through the `responseLanguage` key in `~/.pi/agent/settings.json`.

The ubiquitous language of s2-agent-ext-task — the `/goal` objective driver (with `goal_complete`) and the `todo` step tracker (with `/todos`), kept together because they share a composite status widget and six lifecycle hooks. Ported from @narumitw/pi-goal v0.11.0 (adapted for power-tool embedding). Publishes the `__piGoalActive` seam, surfaced display-only by power-tool's `inspect_tui`; no plan coordinator, wayfind, or `/loop` reads it.

## Language

### The composite widget

**Composite status widget** (`CoreTaskStatusWidget`, key `pi-core-task`):
A single below-editor widget rendering sections in fixed order: goal + loop (both order 0) + todo (1) + wayfind (2). The goal and loop sections share order 0 for stacking continuity — both may render concurrently (`/goal` and `/loop` run independently, CC-style); an inactive section renders `[]`. The plan-coordinator section (order 3) is documented but not currently registered. The reason goal+todo share a package — splitting them across two extensions reintroduces a widget-key ordering flicker (the SDK orders widgets by Map insertion with no index API).
_Avoid_: status bar, overlay (it is the composite widget keyed for deterministic stacking)

### Objective layer

**`/goal`**:
The command that drives one objective to completion within a session — owns iteration counting, token budget, and recovery. Published to the coordination seam while active.
_Avoid_: task, target (a goal is a session-scoped objective driven to done — distinct from a todo step or a plan phase)

**`goal_complete`**:
The tool that marks the active goal complete (only after all required work is verified). Blocked while the plan coordinator reports open phases.
_Avoid_: finish, done (it is the verified completion signal for `/goal`)

**goal module layering** (`src/goal/`):
`goal.ts` is the facade — command registration, the `goal()` entry point, and one-hop re-exports of everything moved out; it is what `../goal.js` still resolves to for every test and consumer. Below it the graph runs strictly one way and is verified acyclic:
`goal → {hooks, lifecycle, goal-complete-tool} → status → prompting → internals → context`.
The layering is load-bearing, not cosmetic: `internals` (leaf helpers) is reached by everyone, `status` owns the overlay + both timers, and the timers call `prompting`. That is why `updateStatus`/`setAndPersistGoal`/`clearActiveGoal` live in `status.ts` rather than with the other leaf helpers — grouping them by name instead of by direction produces `internals → status → prompting → internals`.
_Avoid_: helpers, utils, shared (each module is one concern; nothing here is a grab bag)

### Step layer

**`todo` (TUI face)**:
The in-session step tracker's RENDER layer — since cc-parity-task-powertool t02/D7 the `todo` mega-tool is retired; the model-visible family is ext-subagent's core-gated `task_create/get/list/update` over the shared TeamTaskStore, and this package renders that board (bottom section of the composite widget, `/todos`, effective blockedBy pre-filtered by `board-view.ts`).
_Avoid_: checklist; calling the widget a "store" (the board's rules live in core-runtime; ext-task only renders)

**`/todos`**:
The command to view the board's tasks, grouped by status.
_Avoid_: task list (the board is shared with spawn children and workflow agents — one board, not a private list)

**`/loop`**:
The command that runs a prompt on a recurring interval (CC parity): 1m–~23d cadence (default 10m), idle-gated fires (busy postpones a minute, never drops), 7-day max-age self-stop, session-store restore across restarts, and a persisted `nextFireAt` honored on restore. Runs concurrently with `/goal` (CC-style); only one loop at a time — `/loop stop` first. The `dynamic`/`off` arguments redirect to ultracode's `/loop` (the `schedule_wakeup` self-paced variant).
_Avoid_: repeat, batch (it is a recurring-prompt timer chain with idle gating, not a queue runner)

**`/list`**:
The command that inspects and manipulates the goal queue — shows the queue state, reorders items, parks/unparks goals, and removes entries. The queue advances on goal completion (the reviewer's auto-advance enqueues here), NOT via `/loop`. Used during review to manage the pending goal sequence.
_Avoid_: show, display (it is a queue manipulation command, not just a viewer)

### Coordination

**Coordination seam** (`globalThis.__piGoalActive`):
The process-singleton reader ext-task publishes so a peer can surface goal activity WITHOUT a hard dep. A peer reads `typeof __piGoalActive === "function" && __piGoalActive() === true`. ext-task is the publisher; the only reader is power-tool's display-only `inspect_tui` — no plan coordinator, wayfind, or `/loop` reads it (goal and loop run concurrently by design).
_Avoid_: hook, signal (it is a published globalThis reader for cross-extension state display)

**Session-only board**:
The shared task board is SESSION-ONLY in-memory state (TeamTaskStore; reset on `session_start`, dropped on `session_shutdown` — both owned by ext-subagent) — never replayed from the session branch, never seeded from disk plans. `session_compact` / `session_tree` do NOT replay either. Permanent task tracking lives in wayfind/superpowers plans & tickets; the board is a transient working surface shared by the parent, spawn children, and workflow agents.
_Avoid_: restore, persist, replay (the board is ephemeral session state, deliberately not reconstructed from history)

**Plan-coordinator asymmetry (L13)**:
The goal subsystem self-consumes the plan coordinator directly via internal calls (`planningGateBlocking()`, `planProgressLineFromPeer()`), while wayfind reads the same coordinator through published `__piPlan*` seams. This is intentional — goal needs immediate access to phase gating and progress, wayfind needs display-only coordination. The plan coordinator is a one-way publisher (ext-task → wayfind); there is no "yielding" behavior or bidirectional handshake.
_Avoid_: yield, handoff (it is a publish-consume pattern, not a state transfer)

**Published coordination seams** (ext-task → peers via `globalThis`):
Core-task publishes four coordination seams:
- **Goal-side (1):** `__piGoalActive` — `() => boolean` goal-activity reader, published in `extensions/task.ts` from `isGoalActive`; read display-only by power-tool's `inspect_tui`. `crossPackage: false` in `core-interface/src/seam-keys.ts`. (Grep for the key, not for a line number — citations here have gone stale before.)
- **Plan-side (3):** `__piPlanPhases`, `__piPlanIncomplete`, `__piPlanSummary` — `(cwd) => …` readers of the active plan, all consumed by wayfind.
All four are one-way publishes from ext-task; only power-tool's `inspect_tui` (goal-side) and wayfind (plan-side) read them.
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
Strips `ask_user_question` from the active tool set when the session has no UI, and restores it when one appears — so the model is never offered a dialog that cannot render. (Malformed calls are instead rejected at execute time by `validateQuestionnaire`.)
_Avoid_: validator, normalizer (it is a hasUI availability gate on `before_agent_start`)

## Language — response-language

The `/response-language` command (relocated from its own package): live control of the agent's reply language. Self-contained — no shared widget, hooks, or state with goal/todo/ask-user.

**`/response-language`**:
The command that shows or sets `responseLanguage` in `~/.pi/agent/settings.json`. No arg shows the current value; a BCP-47 tag sets it; invalid input is rejected. Setting it just writes the key — no prompt reload — because the paired patch re-reads settings on the next turn, so the next reply already uses the new language.
_Avoid_: locale switch, i18n toggle (it is a settings-key setter that drives the forced-injection patch, not a translation layer)

**Forced-injection pair** (`force-response-language` patch in `s2-agent`):
The other half of the feature — lives in `s2-agent/src/patches/` because it wraps `AgentSession.prototype._installAgentNextTurnRefresh` to prepend a forced `<response_language>` block to every turn's system prompt, reading `settings.json` fresh each turn. The command writes the key; the patch re-reads it on the next turn (no reload needed). That cross-package coupling through `settings.json` is the whole integration.
_Avoid_: language enforcer, prompt builder (it is a per-turn system-prompt patch paired with this command, owned by s2-agent)
