# s2-agent-ext-subagent

The ubiquitous language of the isolated single-subagent dispatch subsystem — the `subagent` + `list_subagent_runs` tools, the `WorkflowAgent` runner, the `spawnSubagent` programmatic API, and the process-wide singletons that let a viewer observe in-flight and completed runs. Extracted from `s2-agent-ext-ultracode` so the subagent capability loads independently of the workflow DSL and so peer extensions can depend on it without the workflow engine.

## Language

### Core noun

**Subagent**:
One isolated child Pi session, spawned ad-hoc by the model (via the `subagent` tool) or by peer-extension code (via `spawnSubagent`/`agent()`). Runs in a fresh in-memory session with its own context window; the parent never sees its intermediate steps — only the final result.
_Avoid_: child process, worker, thread (a subagent is an in-process Pi session driven by `WorkflowAgent`, not an OS process).

**Spawn** (`spawnSubagent`):
The publicly-exported wrapper over `WorkflowAgent.run` for **programmatic** single-subagent dispatch from peer-extension CODE (not the LLM tool path). Stabilized as a public surface so `s2-agent-ext-knowledge-card` (`zk_card`/`zk_ask`), `s2-agent-ext-wayfind`, `s2-agent-ext-superpowers` import it instead of re-implementing a child runner. Returns `{ output, failure?, usage?, budgetWarning? }` — see **Failure**.
_Avoid_: re-implementing a child runner in a peer extension (call `spawnSubagent` instead); reaching into `./src/spawn-subagent.ts` directly (it is exported from the package root).

**Failure** (`SubagentFailure`, `result.failure`):
Why a run did not succeed — a discriminated union of `failed` / `timedout` / `turns` / `budget`, **absent on success**. `failure.kind` IS the run's status: there is nothing to derive and no flags to correlate. Every variant carries `message`, so a caller that only wants to report what went wrong never switches on `kind`. The two detail-bearing variants require their detail object, and that PRESENCE is what selects the kind — a turns error arriving without details is a plain `failed`.

The taxonomy has exactly one home: `classifyError`'s branch order in `spawn-subagent.ts`, pinned case-by-case by `tests/failure-union.test.ts`. It replaced `{ exitCode, stderr, timedOut, budget, turns }` — subprocess vocabulary for a runner with no process, whose numeric range was dead (nothing read `124`; a budget abort wrote `exitCode: 1`, indistinguishable from a plain failure) and whose five fields forced every caller to correlate. The persisted surfaces dropped their `exitCode`/`timedOut` for the same reason and renamed `stderr` → `error`, with a read shim for older records. See [ADR-subagent-0003](docs/adr/0003-failure-union-over-subprocess-vocabulary.md).
_Avoid_: `exitCode` / `stderr` / `timedOut` anywhere on a spawn result or a run record (all gone); a second place that maps a failure to a status; `aborted` as a failure kind (the parent turn owns that — see **Child dispatch**).

### LLM-facing tools (this package owns them)

**`subagent` (tool)**:
The LLM-facing tool for one ad-hoc isolated child run — the model calls it directly, no orchestration. Same runner as `agent()` and `spawnSubagent()`. Reports real usage, accepts `timeoutMs` (defaults to 15 min via `DEFAULT_TIMEOUT_MS` if omitted — a backstop against a stuck child blocking the parent turn)/`retryOnTransient`/`agentType`/`schema`/`model`/`tier`. Declares `executionMode: "sequential"` so pi serializes any turn containing a `subagent` call. Owned by this package's extension (`extensions/subagent.ts`).
_Avoid_: mini-workflow, single-agent script (it is a standalone tool call, not a `workflow` run of one agent).

**`list_subagent_runs` (tool)**:
The LLM-facing inspection tool — lists completed `subagent`-tool runs (newest-first, filterable by status, with a get-by-id subcommand) backed by the run-persistence store, plus `wait`/`stop` actions for live background runs. The registered tool NAME is `list_subagent_runs` (the bare `subagent_runs` spelling lingers only in factory/type symbol names like `createSubagentRunsTool`). Owned by this package's extension.
_Avoid_: conflating with the `/subagents` interactive viewer (a TUI slash-command living in this package's `src/subagent-viewer.ts`, reading the same persistence singleton); using the bare `subagent_runs` name in LLM-facing prompts (the model sees `list_subagent_runs`).

**Background dispatch** (`background:true` on `subagent`, `BackgroundRunManager`):
A dispatch that is background FROM BIRTH: `execute` returns immediately with the run id and `details.status` `"running"` (the transcript renders that immediate return as a muted `⌛ running` badge — the run is live, the parent turn moved on), and the whole dispatch+finalize lifecycle (worktree, watchdog, persistence) continues in-process inside the manager-tracked completion. The parent is woken by a **Task notification** when the run ends. The registry entry registers `foreground:false` + `background:true`, so the dock/notify/viewer pick it up through `RunView`; a live background run is awaitable via `list_subagent_runs` `{action:"wait"}` and killable via `{action:"stop"}`. No `parentSignal` reaches `dispatchChild` — the run deliberately outlives the dispatching turn. See [ADR-subagent-0007](docs/adr/0007-background-dispatch-turn-decoupling.md).
_Avoid_: conflating with **Detached** (a mid-flight handoff to an OS subprocess via `alt+s`; a background dispatch never leaves the process); awaiting a background run inside the dispatching turn (that is what `list_subagent_runs` `wait` is for); a second roster (`BackgroundRunManager` — claim/track/release plus notification delivery — is the only background bookkeeping).

**Task notification** (`formatTaskNotification`, `wireBackgroundDeliverer`):
The `<task-notification>` followUp message delivered when a background run completes — run id, agent/model, status, usage, a ~600-char result preview, and the `list_subagent_runs` `get` fetch hint. Sent by `wireBackgroundDeliverer(pi)` as a CustomMessage OBJECT, not a string: `pi.sendMessage({ customType: "subagent-task-notification", content, display: true }, { deliverAs: "followUp", triggerTurn: true })`. `followUp` queues the message into the RUNNING turn while the parent is busy; `triggerTurn: true` is what opens a fresh turn when the parent is idle — without it an idle parent is never woken (the message is merely appended). Best-effort and silent on failure — the completed run is already in run-persistence, so `list_subagent_runs` still sees it.
_Avoid_: `deliverAs: "followUp"` without `triggerTurn` (never wakes an idle parent); passing a raw string to `sendMessage`; retrying a failed delivery; putting the full output in the notification (the preview decides, `get` fetches); waking the parent any other way (this is the one seam).

**Child dispatch** (`dispatchChild`, `src/child-dispatch.ts`):
The single place one isolated child run is DRIVEN. Owns the per-child abort controller and the parent-turn-signal fan-in, the in-flight registry lifecycle, capture of the ACTUAL resolved model (and any fallback), history streaming, the commit-scope audit, and the user-abort-vs-whole-turn-Esc distinction — which is why `aborted` is the one status not reachable from a spawn result's **Failure**. Both LLM-facing tools call it: the `subagent` tool once, the `subagents` tool once per batch child.

The callers keep what genuinely differs — building the spawn REQUEST (agentType resolution, worktree isolation, the batch's non-overridable read-only exclusion), the watchdog, the circuit breaker, rendering, and persistence. **This module owns the run, not the request.**

It exists because the two tools previously each held a hand-maintained copy of that policy, kept aligned by ten "mirrors the singular tool" comments — and the copies drifted twice in ways the code itself records: the actual-model capture reached only the singular tool (a batch child that fell back rendered the REQUESTED model under a ✓ done badge), and the default-on commit-scope audit likewise.

Where the two tools still differ, the difference is stated at the call site instead of left to drift: the singular tool audits commits even with no declared scope (its child holds raw `bash`), the batch tool only when a scope is declared (its children have edit/write/bash excluded and cannot reach git).
_Avoid_: adding per-child dispatch policy to either tool's `execute` (it belongs here, or the two will diverge again); passing `externalSignal`/`onModelResolved`/`onModelFallback`/`onHistory`/`onUsage` in the request (this module owns those five fields and overwrites them).

### Runner

**`WorkflowAgent`**:
The engine's LLM caller — a thin adapter over Pi's `createAgentSession()`. Owns no `fetch`, no provider SDK, no HTTP path to any LLM (its only runtime dep is `acorn`, the script parser). Every spawn constructs a fresh Pi session and drives it with `session.prompt()`. Despite the `Workflow` prefix in the name (retained from the pre-extraction codebase for symbol continuity), it is the SHARED runner for `spawnSubagent`, the `subagent` tool, and workflow's `agent()` — not a workflow-only class.
_Avoid_: "workflow agent" implying it only runs inside a workflow (it runs every subagent dispatch).

### Singletons + the sharing contract

**In-flight registry** (`getSubagentInFlightRegistry()` → `SubagentInFlightRegistry`):
Process-local registry of RUNNING subagent dispatches. The `subagent` tool registers on start, streams throttled history, and deregisters on completion, so a viewer can show a "Running" section with live elapsed while a child is mid-flight — closing the gap that running subagents were invisible until they finished. Process-local by design: a subagent runs in-process, so all live runs are in this process.
_Avoid_: persisting in-flight entries (they are transient; completed runs go to run-persistence).

**Live-agent registry** (`getLiveAgentRegistry()` → `LiveAgentRegistry`):
Process-local registry of NAMED live agents (see the named-live-agent term below) — the address book follow-up routing resolves `name`/`agentId` against. Entries stay until explicit release, LRU eviction (`SUBAGENT_MAX_LIVE`), or session_shutdown; they NEVER leave on exchange completion, which is the whole difference from the in-flight registry. Lives in `@repo/s2-agent-core-runtime` alongside the in-flight registry under the same singleton-sharing contract.
_Avoid_: routing follow-ups through the in-flight registry (its entries are evicted when the awaited tool call returns — a named agent outlives that by design).

**Run-persistence** (`getSubagentRunPersistence()` → `SubagentRunRecord` store):
Durable, inspection-only records of COMPLETED `subagent`-tool runs, for post-session replay/debug. Home: `~/.pi/subagents/runs/<id>.json` (global per-user; the record carries `cwd` so a viewer can scope later). JSON-per-run, atomic tmp+rename write, last-N retention (default 200). Records are write-once (never mutated). A named live agent writes one record per exchange, linked across exchanges by `agentId` — the RECORDS stay write-once; the SESSION lives elsewhere.
**Deliberately separate from workflow `RunPersistence`**: that layer is workflow-RESUME machinery (journal = replay source-of-truth, cross-process lease, pause/resume). A subagent run is a one-shot dispatch whose record exists purely for inspection — and a NAMED live agent (below) is a persistent session re-prompted in place, NOT a journaled replay. Mixing either into the workflow journal would muddy its canonical-resume invariant.
_Avoid_: persisting subagent runs through the workflow journal (use this separate store); treating the record as mutable (it is write-once); "resuming" a named agent by replaying its records (re-prompt the live session).

**Named live agent** (`spawn_subagent` `name` param → `LiveAgent` in core-runtime):
A child session that SURVIVES its first exchange. Spawn with `name: "researcher"` and the session is registered (not disposed) when the first exchange returns; later dispatches address it by that handle (or its `agentId` = the first exchange's toolCallId). Budget/turn guards attach once at open and read CUMULATIVE session stats, so `tokenBudget`/`maxTurns` bound the agent's WHOLE LIFETIME, not per dispatch; `timeoutMs` applies per exchange. In-memory only, scoped to the parent session — session_shutdown disposes all; there is no cross-restart live-session resume (the detach-manifest path is the separate OS-subprocess persistence story). LRU-capped by `SUBAGENT_MAX_LIVE` (default 6); a mid-exchange agent is never evicted. Incompatible with `schema` (one-shot contract) and worktree isolation (the worktree dies when the first exchange returns). No transient retry — a retry needs a fresh session, and the named agent's value IS its persistent one.
_Avoid_: "resume" for a named agent's follow-up (say *re-prompt*; "resume" is the detach-manifest/workflow-journal word); "teammate"/"team" until team addressing ships (a named agent is addressable, not yet a peer).

**send_message** (`src/send-message-tool.ts` → the `send_message` tool):
Follow-up messaging over the live-agent registry. `to` resolves by `name`, then `agentId`; a MID-FLIGHT agent is steered (the message joins its current exchange — "delivered", no separate reply), an IDLE agent is re-prompted (default waits for the reply; `wait:false` returns immediately and the reply arrives as a `<task-notification>` through the BackgroundRunManager deliverer). A terminal lifetime failure (budget/turns) on send releases the agent from the roster — records survive, keyed by `agentId`. `to:"main"` is the CHILD-side half: it publishes through the process-singleton **ParentMessageBus** (`src/parent-message-bus.ts`), whose deliverer the extension entry wires with `pi.sendMessage(..., {deliverAs:"followUp", triggerTurn:true})` — the same wake seam as the background deliverer, and the ONLY child→parent channel (pi has no custom-message handler API). A child's own identity is the self-declared `from` param — in-process children share the tool instance, so there is no implicit session identity to read.
_Avoid_: extending `list_subagent_runs` with a send action (it is read-oriented list/get/wait/stop; mutating actions get their own verb_object tool); a direct child→child or child→parent session channel (everything routes through the bus or the parent); reusing formatTaskNotification for a wait:false reply (its "Full output" pointer resolves to the FIRST exchange's record — follow-up exchanges persist nothing; use formatReplyNotification, which inlines the reply); "resume" (see named live agent).

**Known seam ahead of its design (tickets 04-05 will own it)**: the registry is process-global and the tool checks no sender identity, so (a) a child can already send_message to a SIBLING named agent by name — the sibling's reply returns to the child and the parent never sees it; (b) a nested child's `to:"main"` reaches the ROOT session, not its intermediate parent. Both are deliberate non-fixes for ticket 02: sibling addressing is specced as parent-BROKERED (both sides see it) and lands with team addressing; until then, treat direct child→sibling routing as an undocumented capability, not a contract.

**Team task list** (`task_create`/`task_get`/`task_list`/`task_update` over `TeamTaskStore` in core-runtime):
The SHARED board coordinating the parent, named live agents, and workflow agents of ONE session: tasks `{id, subject, description, activeForm?, status: pending|in_progress|completed, owner?, blocks/blockedBy (symmetric, cycle-rejecting), metadata?}` on a process-singleton store keyed by parent sessionId. Session-scoped IN-MEMORY by design — `session_start` resets it, `session_shutdown` drops it, nothing persists. The parent registers the four tools and children receive them through the SAME `extensionTools` bridge as `send_message` (read-only children keep them: they mutate the board, never the filesystem). All rules (ids, edge symmetry, cycle rejection, owner validation) live in the store; `src/task-tools.ts` only shapes schemas and renders results. This is NOT ext-task's todo: that tracker is ONE session's private step list (see ext-task CONTEXT), while this board's entire point is cross-agent sharing.
_Avoid_: `todo` for this board (that is ext-task's session scratchpad), `goal` (ext-task `/goal`'s word for a session objective), `ticket` (wayfind's word for a durable planning unit); persisting the board anywhere (permanent tracking lives in wayfind); putting task-edge logic in the tool adapters (it lives in `TeamTaskStore`).

**Singleton-sharing contract** (module identity):
`getSubagentInFlightRegistry()`, `getSubagentRunPersistence()`, and `getLiveAgentRegistry()` are **module-local lazy singletons**, so every observer must land on ONE module instance. They do, and **no special import path is required**: this package's `exports["."]` maps to `./src/index.ts` (there is no `dist/` entry), so the package root and the `src/` subpath are the same module. All three live in `@repo/s2-agent-core-runtime`, whose root likewise maps to its own `src/index.ts` — so every spelling resolves to one registry each. `s2-agent-ext-obsidian` imports the singletons from `@repo/s2-agent-core-runtime` directly (it ships in the portable base set, which forbids ext→ext edges — see tests/barrel-surface.test.ts FACADE_SYMBOLS).

`tests/rate-limiter-cross-pkg.test.ts` pins the observable half behaviorally (hold the only slot of a cap-1 limiter via the core-runtime path; the package-root path must BLOCK on the same budget), so the guarantee survives any change in how the linker dedupes module records.
_Avoid_: the retired "import via the `src/` subpath, NOT the dist root" rule (it described a `dist/` entry point this package does not have); copying the registry/persistence into a peer extension (share the singleton instead).

**Barrel facade rule** (`src/index.ts`):
The barrel exports everything this package owns, plus exactly those `@repo/s2-agent-core-runtime` symbols that a peer imports THROUGH it. The facade is load-bearing, not stylistic: `s2-agent`, `s2-agent-ext-obsidian`, `s2-agent-ext-file2md` and `s2-agent-ext-knowledge-card` do not declare core-runtime, and the dep-guard rejects an undeclared `@repo` edge. `tests/barrel-surface.test.ts` checks BOTH directions — an unsanctioned re-export fails, and so does a facade entry whose named peer has moved off the barrel.
_Avoid_: re-exporting a core-runtime symbol "for convenience" (the barrel reached 114 names of which 21 were ever imported); importing through this package's own barrel from inside `src/`.

### Supporting concepts

**Agent registry** (`loadAgentRegistry` / `AgentDefinition`):
The `.pi/agents/*.md` definition store — name/description/tools/model/prompt/worktree-isolation per named agent type. Resolved via `agentType` on the `subagent` tool and `agent()`; explicit call-site `model`/`tools`/`excludeTools` override the binding. Bundled agents in a workflow pack register per-run with project > pack > user precedence.
_Avoid_: conflating with the in-flight registry (the agent registry is definitions; the in-flight registry is running instances).

**Model tier / model role** (`loadModelTierConfig` / `resolveTierModel` / `resolveModelRole`):
The two model-resolution dimensions, driven by ONE config file: `~/.pi/workflows/model-tiers.json` (`{ tiers, capabilities }`, editable via `/workflows-models`). `tiers` maps a named tier (small/medium/big) → model-spec; `capabilities` maps a capability key (e.g. `vision`) → model-spec. The two dimensions are INDEPENDENT by design — switching text-LLM tiers (e.g. the default provider ↔ a token-exhaustion fallback) must never touch vision, which is always a separate (often local) model since most text-LLM providers cannot do vision. Resolution precedence on a dispatch: explicit `model` > `capability`-resolved > `tier`-resolved > session `mainModel` default.
_Avoid_: **hardcoding model ids ANYWHERE in code** — model ids differ per working environment (the local vision model, the default text-LLM provider, the fallback provider are all machine-specific). Resolve every model from config (`tiers` / `capabilities`); config files (`~/.pi/workflows/model-tiers.json`, `~/.pi/agent/models.json`) are the ONLY place env-specific model ids may live. This applies to agent definitions too — reference `tier`/`capability`, never a literal id. (Audit 2026-07-26: subagent src is clean — no hardcoded model-id values.)

**Preset** (`/models-preset`, `MODEL_PRESETS`, `setTransientModelTierConfig`):
A named, version-controlled model-config template (`glm-lmstudio`, `deepseek-pro`, `deepseek-flash` — the one place concrete model ids may appear in this package, as labeled templates). Applying one is a **transient session switch**: the main model changes live (`pi.setModel`) and tier/capability routing follows an in-memory, process-scope override for the session; `session_start` clears it. A preset NEVER writes to `~/.pi` — the only writer of the tier file is the host's built-in startup seed, and persistent edits go through `/workflows-models` explicitly. See [ADR-subagent-0006](docs/adr/0006-models-preset-transient-session-switch.md).
_Avoid_: persisting a preset to `~/.pi/workflows/model-tiers.json` (regression to the retired behavior); treating a preset as machine setup (it is a per-session switch); resolving presets' `small`/`medium` as the main chat model (`big` is the headline model users read in the label).

**Worktree isolation** (`createWorktree` / `removeWorktree`):
Git-worktree-based isolation for a subagent that should not touch the parent's working tree. An agent definition opts in; the runner creates a linked worktree for the run and removes it after.
_Avoid_: "container" (it is a git worktree, not an OS container).

## Ownership boundary (why this package exists)

This package owns: the `subagent` + `list_subagent_runs` TOOLS, the `WorkflowAgent` runner, `spawnSubagent`, the singletons, agent-registry, model-tier, worktree, errors, history helpers, the SDD-report parser, **and (since PR #821 / [ADR-0002](docs/adr/0002-relocate-viewer-command-to-subagent.md)) the `/subagents` interactive TUI viewer + slash command + the progress widget**. The shared agent-row render helpers moved OUT in #1251 — they now live in `@repo/s2-agent-core-runtime` (`src/agent-row-display.ts`) and this package imports them.

It does NOT own: the `workflow`/`workflow_control`/`workflow_help` tools or the workflow orchestration engine (those live in `s2-agent-ext-ultracode`). The viewer/command originally stayed in workflow ([ADR-0001](docs/adr/0001-why-extracted.md)) due to a `display.ts ⟹ workflow.ts` cycle; #821 broke that cycle by extracting the generic render helpers into this package's `agent-row-display.ts`, so the viewer now imports only local code.
