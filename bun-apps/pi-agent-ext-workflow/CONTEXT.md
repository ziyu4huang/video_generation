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

### Workflow pack resolution

**Workflow pack**:
A folder of `manifest.json` + an entry orchestration script — the reusable,
named form of a workflow. Identified by its manifest (vs a single-file script's
`export const meta`). Runs through the same engine as an inline script.
_Avoid_: "extension" (a pack is NOT a pi extension); "template"

**Pack resolver** (`resolveWorkflowScript` / `resolveWorkflowPack`):
The SINGLE source of truth that maps a `<name>` (or path) to runnable script
text, owned by this package (`workflow-pack.ts`). Shared by BOTH entry paths —
the CLI (`pi-agent cli workflow run`) and the `workflow` tool's `name`
parameter — so resolution never drifts between them. Pure + injectable fs.
_Avoid_: "CLI resolver" / "tool resolver" (there is one, in the engine)

**Resolution order** (first hit wins; per location a pack directory beats a
same-name `.js`; the portable tiers 2–3 rank ABOVE the repo tiers — "most local
wins", see `docs/adr/0003-portable-name-resolution-tiers.md`):
1. `<name>` as a literal path (file, or a pack directory via its manifest).
2. `<cwd>/workflows/<name>` (portable tier; no repo root needed).
3. `<binDir>/workflows/<name>` (packs shipped next to the compiled binary).
4. `.pi/workflows/<name>` (project packs, under the repo-root walk-up).
5. `bun-apps/<pkg>/workflows/<name>` (package-local packs).
_Avoid_: ".claude/workflows" (that is Claude Code's Workflow-tool dir, not resolved here)

**`name` (tool parameter)**:
The `workflow` tool's optional pack selector — mutually exclusive with `script`
(exactly one required). Resolves a pack via the shared resolver; the manifest's
default `args` are shallow-merged under the caller's `args`. `manifest.model`
is NOT applied on this path (the session's `mainModel` governs — per-run model
is future work).
_Avoid_: conflating with the inline `script` parameter; "loadSavedWorkflow"
(that resolves saved single-file workflows from `/workflows`, a separate namespace)

**Entry path**:
One of the two ways a pack is reached. Path A: the CLI meta-command (headless,
`--model` overrides `manifest.model`). Path B: the interactive `workflow` tool
`name` param (the workflow extension is built-in in the TUI). Both converge on
the same resolver + engine.
_Avoid_: "mode" (a path is an entry surface, not an execution mode)

### Workflow pack self-containment

**Pack-local state**:
A pack's runtime state (`runs/ outputs/ intermediate/`) lives INSIDE the pack
folder, never in `~/.pi`. Inline scripts keep the global
`~/.pi/workflows/projects/<key>/` store; the two diverge at the `packId` branch
(decision 03 / ADR-0001).
_Avoid_: "pack store in ~/.pi" (there is none); "global pack state"

**`pack-id`**:
Stable identity `<name-slug>-<sha256(absPath)[:12]>`, derived at resolve time,
**version-INDEPENDENT**. Disambiguates same-named packs across locations; keys
redirected state for checked-in packs (decision 08 / ADR-0002).
_Avoid_: name@version (a version bump would orphan `runs/`/`outputs/`)

**`version` (manifest)**:
Optional semver-recommended metadata; NOT part of `pack-id`. Groundwork for the
deferred self-improve loop (north star, out of scope here).

**Checked-in pack state redirect**:
A pack under `bun-apps/<pkg>/workflows/` (a read-only package dir) can't hold
writable state, so its runtime state redirects to
`.pi/workflows/.state/<pack-id>/` (project-local, never `~/.pi`). The pack's
static files (manifest/entry/agents) stay in the package dir.
_Avoid_: a global pack store; "state lives in the package"

**I/O contract** (`io:` block):
Optional manifest fields declaring where inputs/outputs/intermediate/runs live +
retention (`all` | `last-N`). Schema/vocab only; semantics live in the runner.

**Bundled agents** (`agents/*.md`):
A pack's subagent definitions, shipped in the pack, registered per-run via
`packDirs` (precedence project > pack > user). Claude-Code-compatible
comma-string `tools` form supported (the `.pi/agents` mirror extended, not
forked).

**Folder template** (`workflow-pack/template/`):
The canonical skeleton a new pack is scaffolded from (`workflow pack init <name>`):
manifest stub + entry + `agents/` + README + `.gitignore`, plus empty state
dirs with `.gitkeep`. Ships in the published `files:`.

**clean / inspect** (`workflow pack clean|inspect`):
The agent-callable state surface. 3-tier safety: `intermediate` 🟢 (safe,
default scope, no confirm), `runs` 🟡 + `outputs` 🟠 (lossy; dry-run-default,
`--yes` to execute).
_Avoid_: "delete" (clean is a scoped, gated surface)

**On-disk intermediates** (opt-in):
A disposable MIRROR of journal results, materialized to
`intermediate/<phase>/<idx>-<hash>.<ext>` only when `io.intermediate.persist` is
set. The journal stays the resume source-of-truth, so purging the mirror is
always safe (decision 12).
_Avoid_: "intermediates replace the journal" (the journal is canonical)

### Orchestration primitives

**`agent(prompt, opts)`**:
Spawns one isolated subagent; returns its final text, or a validated object when `opts.schema` is set. Recoverable failures return `null` with diagnostics in `/workflows`.
_Avoid_: call, request (it spawns a fresh in-memory Pi session)

**`subagent` (tool)**:
Single ad-hoc subagent dispatch outside a workflow script — the model calls it directly for one isolated child run, no orchestration. Shares the same runner as `agent()`. Reports real usage (`{input, output, cacheRead, cacheWrite, total, cost}`) and accepts `timeoutMs`/`retryOnTransient` overrides (previously hardcoded: no timeout, always retry once). It also accepts `agentType` (resolves via the same `AgentRegistry` the `agentType` entry below describes — tools/model/prompt/worktree isolation from a `.pi/agents/*.md` definition, with explicit call-site `model`/`tools`/`excludeTools` overriding the binding) and `schema` (structured output via the existing `structured_output` machinery). While running, it also streams throttled progress (≥250ms apart, via `WorkflowAgent.run()`'s existing `onHistory`) through the standard `_onUpdate`/`renderResult({isPartial: true})` SDK contract, so the TUI shows the child's latest tool call instead of a bare spinner until completion. Declares `executionMode: "sequential"` (decision 10): pi serializes any turn whose tool-call batch contains a `subagent` call (engine rule — any sequential tool ⇒ batch runs serially), enforcing the contract that concurrent fan-out goes through the `workflow` tool's `parallel()` instead. The `workflow` tool's `parallel()`/`agent()` dispatch via a separate `createAgentSession()` path, so this does NOT throttle workflow fan-out.
_Avoid_: mini-workflow, single-agent script (it is a standalone tool call, not a `workflow` run of one agent)

**`spawnSubagent()` (public API)**:
The shared, **publicly-exported** wrapper over `WorkflowAgent.run` for programmatic single-subagent dispatch from peer-extension CODE (not the LLM tool path). **Owned by `@repo/pi-agent-ext-subagent`** since the subagent extraction, and NOT re-exported from this package — import `spawnSubagent` + `SpawnSubagentOptions` + `SpawnSubagentResult` + `AgentUsage` from `@repo/pi-agent-ext-subagent`. Used by `pi-agent-ext-wayfind`, `pi-agent-ext-superpowers`, `pi-agent-ext-knowledge-card` (`zk_card`/`zk_ask`), `pi-agent-ext-hermes-memory`, `pi-agent-ext-file2md`. Same runner as the `subagent` tool and `agent()`; returns `{output, exitCode, stderr, timedOut, usage?}` (the shape mirrors the old child-process `runSubagentWithRetry` — see the note on the `exitCode`/`stderr` vocabulary in that package's CONTEXT).
_Avoid_: re-implementing a child-process subagent runner in a peer extension (call this instead); importing it from the workflow package root (there is no such export — that back-compat re-export was removed)

**`SubagentRunRecord` / `SubagentRunPersistence` (public API)**:
Durable, inspection-only records of completed `subagent`-tool runs, for post-session replay (`~/.pi/subagents/runs/<id>.json`, JSON-per-run, write-once at completion, last-N retention default 200). Carries the full task prompt, resolved model, status/exitCode, real usage, the final output, and the compact transcript (`AgentHistoryEntry[]`) — everything `/subagents` needs to inspect a run after the in-process child session is gone. **Deliberately separate from workflow `RunPersistence`**: that layer is workflow-RESUME machinery (journal = replay source-of-truth, cross-process lease, pause/resume); a subagent run is a one-shot dispatch with NO resume semantics, so its record exists purely for inspection. Mixing the two would muddy the journal's canonical-resume invariant.
_Avoid_: persisting subagent runs through the workflow journal (use this separate store); treating the record as mutable (it is write-once)

**`SddReport` / `parseSddReport()` (public API)**:
Machine-readable view of a subagent-driven-development implementer's report block (ticket 04). The byte-identical SDD prompt makes the subagent return a ≤15-line prose block whose first line is `**Status:** DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED`; `parseSddReport(output)` turns that into a typed `SddReport` (`status` reliable; `commits`/`testSummary`/`concerns`/`reportFile` best-effort), or `undefined` for a plain non-SDD dispatch. Surfaces on `subagent`-tool `details.report` (a SEPARATE axis from the process `details.status` done/failed/timedout — a run can finish while self-reporting BLOCKED), badges in the result render, and is persisted on the run record. Parity with claude-code's controller, which parses the same prose prefix.
_Avoid_: conflating SDD self-report status with process status (they are orthogonal); editing the SDD prompt template to emit JSON (byte-identical — parse its output instead)

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

**`workflow_control`**:
The model-callable control surface for a background run — `stop`/`pause`/`resume`/`status`/`list`/`wait` — mirroring `/workflows`'s human-typed surface but reachable by the LLM itself without a user typing a command. Only knows `workflow`-tool run ids; a `subagent`-tool call has no run identity to control.
_Avoid_: task management, subagent control

**Activity row**:
The shared one-line renderer (`display.ts`, `renderActivityRow`) for an agent/subagent's live status — icon, actor, model, tokens, and (while running) its most recent tool call — used by the bottom task panel, the `/workflows` navigator's agent list and detail live-tail, and the `/subagents` viewer, so the three surfaces speak one visual language.
_Avoid_: three independent hand-built status-line templates (the pre-existing state this replaces)

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

**`tokenBudget` / `spendBudget` (per-run subagent cap)**:
Optional ceilings on the `subagent` tool (and `WorkflowAgent.run`) that ABORT a
single run mid-run once cumulative token usage (`tokens.total`) or cost (`$`)
exceeds the limit. Checked per-turn (on each session state change, the same
subscribe seam as `onHistory`), so an in-flight turn may overshoot by up to one
turn; on exhaustion the session is aborted and the run surfaces as status
`"budget"` (`details.budget`: `{kind:"tokens"|"spend", limit, actual}`) —
distinct from `done`/`failed`/`timedout`, non-recoverable (never retried —
retrying would re-exhaust the same ceiling). Bounds a SINGLE runaway (looping)
subagent that `timeoutMs` (wall-clock) alone cannot catch. DELIBERATELY distinct
from workflow's run-wide `Budget` above: that is a between-agent SOFT gate
(spent accrues after each agent; an in-flight agent may overshoot and only the
NEXT dispatch is blocked), whereas this is a hard mid-run abort on ONE agent.
`checkBudgetExhaustion` is the pure threshold helper; `BudgetExhaustion` the
record type.
_Avoid_: conflating with the workflow run-wide Budget (different scope +
semantics); "quota"

**`commitScope` (subagent guardrail)**:
An opt-in allowlist of paths a `subagent`-tool run may commit (files or dirs,
prefix-matched). When set, the tool records the repo HEAD before dispatch and,
after the run, diffs `base..HEAD` to flag any committed path that falls OUTSIDE
the scope — the recurring `git add -A` sweep signal (a dispatched implementer
sweeping an untracked `.planning/` stub into a later squash-merge). DETECTION,
not prevention: the child has raw `bash`, so the tool never blocks the sweep;
it surfaces a ⚠ violation in the result text, `details.scopeCheck`, and the
durable run record, leaving the revert to the controller. Best-effort (non-repo
/ git failure → skipped silently); ignored for worktree-isolated runs (their
commits are discarded at teardown). `[]` means "flag any commit" (a read-only
subagent). A separate axis from process status and SDD self-report.
_Avoid_: sandbox, commit-policy, git-wrapper (it is a post-run scope audit, not
an enforced policy)

**Ultracode** (`/ultracode`, `/effort ultra`):
A standing opt-in that auto-arms an exhaustive multi-agent workflow for every substantive message.
_Avoid_: max mode, turbo (it is a per-message standing trigger, not a one-shot flag)

## Why ActivityRow is kept (2026-08-16 spike)

Four production sites depend on it (workflow-ui navigator, task-panel per-phase, subagent-viewer running + completed). Snapshot rows lack `endedAt` (live elapsed can't freeze), and `renderRunRow` has no tokens segment / injectable badge. Revisit only if `renderRunRow` gains those (see `.planning/2026-08-15-snapshot-row-single-source/tickets/05` resolution).
