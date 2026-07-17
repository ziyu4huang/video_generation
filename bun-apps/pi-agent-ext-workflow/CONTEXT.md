# pi-agent-ext-workflow

The ubiquitous language of pi-agent-ext-workflow — Claude Code–style dynamic workflows for Pi: the model writes a small JavaScript orchestration script that fans out many isolated subagents in parallel, keeps intermediate work in script variables (not the chat), and returns only the result.

## Language

### Orchestration model

**Workflow**:
A single orchestration run — a JavaScript script, written by the model or supplied as a file, executed in a sandboxed `vm` that drives subagents via the workflow globals (`agent`, `parallel`, `pipeline`, `phase`).
_Avoid_: job, task, pipeline-as-in-CI (a workflow is a one-off fan-out script, not a CI definition)

**Orchestration script**:
The JavaScript the model writes (or you supply) that calls the workflow globals. First statement exports literal `meta`; the body orchestrates.
_Avoid_: program, recipe, workflow-file (a file holds the script; the script is the logic)

**Sandbox**:
The Node `vm` the script runs in — `Date.now` / `Math.random` / `require` / `fs` / network unavailable, so runs are reproducible. Determinism is what makes resume reliable.
_Avoid_: container, isolate (it is a deterministic vm, not an OS container)

### Orchestration primitives

**`agent(prompt, opts)`**:
Spawns one isolated subagent; returns its final text, or a validated object when `opts.schema` is set. Recoverable failures return `null` with diagnostics in `/workflows`.
_Avoid_: call, request (it spawns a fresh in-memory Pi session)

**`parallel(thunks)`**:
Runs many `() => agent(...)` thunks concurrently; results returned in input order. Bounded to 16 live / 1000 total.
_Avoid_: map, forEach, batch

**`pipeline(items, ...stages)`**:
Fans items through sequential stages `(prev, original, index)` — the ordered-chaining counterpart to `parallel`'s fan-out.
_Avoid_: chain, stream

**`phase(title)`**:
Groups agents in the live view (and optionally caps a per-phase token budget); a display/budget boundary, not an execution primitive.
_Avoid_: step, stage (a *stage* is a pipeline transform; a *phase* is a grouping label)

### LLM layer — thin adapter over Pi

**`WorkflowAgent`**:
The engine's LLM caller — a **thin adapter over Pi's agent session, NOT a
parallel LLM implementation**. It owns no `fetch`, no provider SDK, no HTTP path
to any LLM: its only runtime dependency is `acorn` (the script parser). Every
`agent()` call constructs a fresh Pi session via `createAgentSession()` and drives
it with `session.prompt()`. The engine's value is the workflow control-flow
layered *on top* of those sessions (fan-out / gate / retry / loopUntilDry /
journaling / resume / structured-output repair / token+cost accounting) — never a
second LLM transport.
_Avoid_: "the engine's own agent" / "its own LLM provider" (it delegates all of
that to `@earendil-works/pi-coding-agent`); "provider layer" (there is none in
this package)

**Provider / auth / model resolution (shared, not re-implemented)**:
Model objects resolve through Pi's `ModelRegistry` + `AuthStorage` reading the
*same* `~/.pi/auth.json`, `models.json`, and `SettingsManager` every other Pi
command uses. A `mainModel` is a `provider/modelId` string handed to the session;
the engine never opens its own provider connection or reads its own key.
_Avoid_: "workflow's model registry" (it is Pi's)

**Tool layer (shared, not re-implemented)**:
Tools are Pi's `ToolDefinition` / `defineTool`; the default set is Pi's
`createCodingTools(cwd)`. Engine-defined tools (`structured_output`, web fetch,
workflow trigger, spawn-subagent) are built with `defineTool` and injected via
`createAgentSession({ customTools })` — Pi's extension point, not a second tool
registry. `applyToolPolicy` is an allow/denylist *filter* over Pi's definitions,
not a new registry.
_Avoid_: "workflow tool registry" / "workflow skills" (neither exists; skills are
parsed-but-ignored, `ToolSearch` is absent from this package)

**Per-agent session isolation**:
Each `agent()` call opens a **fresh in-memory session**
(`SessionManager.inMemory()`), not a continuation of any parent session. This is
what makes each call a journaled, resumable, deterministic atom — sharing session
state across agents would break resume. The CLI (`workflow run`) passes only a
model string + `cwd`; the extension path (`/workflows`) additionally threads the
parent's extension tool definitions + model string, but the child session is still
newly constructed. Connection objects are never shared; only the config files are.
_Avoid_: "child reuses the parent's connection" (it reuses the parent's *config*,
not its connection or state)

### Model routing & isolation

**Tier**:
Coarse model routing per agent — `small` / `medium` / `big`, mapped to real models via `/workflows-models`. The cheap→expensive dial.
_Avoid_: size, class, level

**`model` (exact)**:
A per-agent `provider/modelId` that always overrides `tier`.
_Avoid_: model name, provider id

**`agentType`**:
A named definition (`.pi/agents/<name>.md`) binding a subagent's tools + model + role prompt.
_Avoid_: profile, persona

**Worktree isolation** (`isolation: "worktree"`):
Runs a subagent in a throwaway git worktree so parallel agents can edit the same files without clobbering each other.
_Avoid_: branch isolation, checkout (it is a dedicated worktree per agent)

### Execution lifecycle

**Background run**:
The default execution mode — the originating turn ends immediately, a live panel tracks the run, and the result is delivered back (auto-continuing the session) when it finishes.
_Avoid_: async job, detached process (it re-delivers into the session that started it)

**Journal**:
The per-run record of finished agents. On resume, the journal replays the unchanged prefix (no re-run, no tokens) and runs only what is left or what changed.
_Avoid_: log, history, cache (it is replay-resume state, not a record)

**Saved workflow**:
A run's script turned into a reusable `/<name>` command; composable from inside other scripts via `workflow(name, args)`.
_Avoid_: template, macro

### Quality & control

**Quality pattern**:
A built-in stdlib global for cross-checking — `verify`, `judgePanel`, `loopUntilDry`, `completenessCheck` (adversarial review, best-of-N, exhaustive discovery).
_Avoid_: helper, utility

**Checkpoint**:
A journaled, replayable human-approval gate inside a script (`checkpoint(prompt, opts)`).
_Avoid_: prompt, pause (it is an approval gate with resume semantics)

**Budget**:
The real-token tracker `{ total, spent(), remaining() }`, read from each subagent's session (not estimated). No default cap unless `tokenBudget` / phase budgets add one.
_Avoid_: limit, quota

**Ultracode** (`/ultracode`, `/effort ultra`):
A standing opt-in that auto-arms an exhaustive multi-agent workflow for every substantive message.
_Avoid_: max mode, turbo (it is a per-message standing trigger, not a one-shot flag)
