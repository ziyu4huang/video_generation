# pi-agent-ext-core-task

Also owns `ask_user_question` (merged from `pi-agent-ext-ask-user` on 2026-07-18 — see the "ask_user_question" section below). It shares no code or state with goal/todo; it was relocated here as the first step of a broader "core-task pi-ext" consolidation, not because of a runtime coupling.

The ubiquitous language of pi-agent-ext-core-task — the `/goal` objective driver (with `goal_complete`) and the `todo` step tracker (with `/todos`), kept together because they share a composite status widget and six lifecycle hooks. Extracted from power-tool. Publishes the `__piGoalActive` coordination seam that the plan coordinator and wayfind read.

## Language

### The composite widget

**Composite status widget** (`CoreTaskStatusWidget`, key `pi-core-task`):
A single above-editor widget rendering goal (top) + todo (bottom) in fixed order. The reason goal+todo share a package — splitting them across two extensions reintroduces a widget-key ordering flicker (the SDK orders widgets by Map insertion with no index API).
_Avoid_: status bar, overlay (it is the composite goal+todo widget keyed for deterministic stacking)

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

### Coordination

**Coordination seam** (`globalThis.__piGoalActive`):
The process-singleton reader core-task publishes so peer extensions (the plan coordinator, wayfind) can detect an active goal WITHOUT a hard dep. The peer reads `globalThis.__piGoalActive?.() ?? false`. core-task is the publisher; the plan coordinator yields to it.
_Avoid_: hook, signal (it is a published globalThis reader for cross-extension turn-ownership)

**Replay-from-branch**:
On `session_start` / `session_compact` / `session_tree`, the todo state is replayed from the session branch (`replaceState(replayFromBranch(ctx))`) — so todos survive compaction and tree operations.
_Avoid_: restore, persist (it is branch-replay state restoration)

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
