# pi-agent-ext-goal-todo

The ubiquitous language of pi-agent-ext-goal-todo — the `/goal` objective driver (with `goal_complete`) and the `todo` step tracker (with `/todos`), kept together because they share a composite status widget and six lifecycle hooks. Extracted from power-tool. Publishes the `__piGoalActive` coordination seam that the plan coordinator and wayfind read.

## Language

### The composite widget

**Composite status widget** (`PowerToolStatusWidget`, key `pi-power-tool`):
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
The process-singleton reader goal-todo publishes so peer extensions (the plan coordinator, wayfind) can detect an active goal WITHOUT a hard dep. The peer reads `globalThis.__piGoalActive?.() ?? false`. goal-todo is the publisher; the plan coordinator yields to it.
_Avoid_: hook, signal (it is a published globalThis reader for cross-extension turn-ownership)

**Replay-from-branch**:
On `session_start` / `session_compact` / `session_tree`, the todo state is replayed from the session branch (`replaceState(replayFromBranch(ctx))`) — so todos survive compaction and tree operations.
_Avoid_: restore, persist (it is branch-replay state restoration)
