# pi-agent-ext-subagent

The ubiquitous language of the isolated single-subagent dispatch subsystem — the `subagent` + `subagent_runs` tools, the `WorkflowAgent` runner, the `spawnSubagent` programmatic API, and the process-wide singletons that let a viewer observe in-flight and completed runs. Extracted from `pi-agent-ext-workflow` so the subagent capability loads independently of the workflow DSL and so peer extensions can depend on it without the workflow engine.

## Language

### Core noun

**Subagent**:
One isolated child Pi session, spawned ad-hoc by the model (via the `subagent` tool) or by peer-extension code (via `spawnSubagent`/`agent()`). Runs in a fresh in-memory session with its own context window; the parent never sees its intermediate steps — only the final result.
_Avoid_: child process, worker, thread (a subagent is an in-process Pi session driven by `WorkflowAgent`, not an OS process).

**Spawn** (`spawnSubagent`):
The publicly-exported wrapper over `WorkflowAgent.run` for **programmatic** single-subagent dispatch from peer-extension CODE (not the LLM tool path). Stabilized as a public surface so `pi-agent-ext-knowledge-card` (`zk_card`/`zk_ask`), `pi-agent-ext-wayfind`, `pi-agent-ext-superpowers` import it instead of re-implementing a child runner. Returns `{ output, failure?, usage?, budgetWarning? }` — see **Failure**.
_Avoid_: re-implementing a child runner in a peer extension (call `spawnSubagent` instead); reaching into `./src/spawn-subagent.ts` directly (it is exported from the package root).

**Failure** (`SubagentFailure`, `result.failure`):
Why a run did not succeed — a discriminated union of `failed` / `timedout` / `turns` / `budget`, **absent on success**. `failure.kind` IS the run's status: there is nothing to derive and no flags to correlate. Every variant carries `message`, so a caller that only wants to report what went wrong never switches on `kind`. The two detail-bearing variants require their detail object, and that PRESENCE is what selects the kind — a turns error arriving without details is a plain `failed`.

The taxonomy has exactly one home: `classifyError`'s branch order in `spawn-subagent.ts`, pinned case-by-case by `tests/failure-union.test.ts`. It replaced `{ exitCode, stderr, timedOut, budget, turns }` — subprocess vocabulary for a runner with no process, whose numeric range was dead (nothing read `124`; a budget abort wrote `exitCode: 1`, indistinguishable from a plain failure) and whose five fields forced every caller to correlate. The persisted surfaces dropped their `exitCode`/`timedOut` for the same reason and renamed `stderr` → `error`, with a read shim for older records. See [ADR-subagent-0003](docs/adr/0003-failure-union-over-subprocess-vocabulary.md).
_Avoid_: `exitCode` / `stderr` / `timedOut` anywhere on a spawn result or a run record (all gone); a second place that maps a failure to a status; `aborted` as a failure kind (the parent turn owns that — see **Child dispatch**).

### LLM-facing tools (this package owns them)

**`subagent` (tool)**:
The LLM-facing tool for one ad-hoc isolated child run — the model calls it directly, no orchestration. Same runner as `agent()` and `spawnSubagent()`. Reports real usage, accepts `timeoutMs` (defaults to 15 min via `DEFAULT_TIMEOUT_MS` if omitted — a backstop against a stuck child blocking the parent turn)/`retryOnTransient`/`agentType`/`schema`/`model`/`tier`. Declares `executionMode: "sequential"` so pi serializes any turn containing a `subagent` call. Owned by this package's extension (`extensions/subagent.ts`).
_Avoid_: mini-workflow, single-agent script (it is a standalone tool call, not a `workflow` run of one agent).

**`subagent_runs` (tool)**:
The LLM-facing inspection tool — lists completed `subagent`-tool runs (newest-first, filterable by status, with a get-by-id subcommand) backed by the run-persistence store. Owned by this package's extension.
_Avoid_: conflating with the `/subagents` interactive viewer (a TUI slash-command living in this package's `src/subagent-viewer.ts`, reading the same persistence singleton).

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

**Run-persistence** (`getSubagentRunPersistence()` → `SubagentRunRecord` store):
Durable, inspection-only records of COMPLETED `subagent`-tool runs, for post-session replay/debug. Home: `~/.pi/subagents/runs/<id>.json` (global per-user; the record carries `cwd` so a viewer can scope later). JSON-per-run, atomic tmp+rename write, last-N retention (default 200). Records are write-once (never mutated).
**Deliberately separate from workflow `RunPersistence`**: that layer is workflow-RESUME machinery (journal = replay source-of-truth, cross-process lease, pause/resume). A subagent run is a one-shot dispatch with NO resume semantics; its record exists purely for inspection. Mixing the two would muddy the journal's canonical-resume invariant.
_Avoid_: persisting subagent runs through the workflow journal (use this separate store); treating the record as mutable (it is write-once).

**Singleton-sharing contract** (module identity):
`getSubagentInFlightRegistry()` and `getSubagentRunPersistence()` are **module-local lazy singletons**, so every observer must land on ONE module instance. They do, and **no special import path is required**: this package's `exports["."]` maps to `./src/index.ts` (there is no `dist/` entry), so the package root and the `src/` subpath are the same module. `getSubagentInFlightRegistry` itself now lives in `@repo/pi-agent-core-runtime`, whose root likewise maps to its own `src/index.ts` — so all three spellings resolve to one registry. `pi-agent-ext-obsidian` imports both singletons from the plain package root and is correct to do so.

`tests/rate-limiter-cross-pkg.test.ts` pins the observable half behaviorally (hold the only slot of a cap-1 limiter via the core-runtime path; the package-root path must BLOCK on the same budget), so the guarantee survives any change in how the linker dedupes module records.
_Avoid_: the retired "import via the `src/` subpath, NOT the dist root" rule (it described a `dist/` entry point this package does not have); copying the registry/persistence into a peer extension (share the singleton instead).

**Barrel facade rule** (`src/index.ts`):
The barrel exports everything this package owns, plus exactly those `@repo/pi-agent-core-runtime` symbols that a peer imports THROUGH it. The facade is load-bearing, not stylistic: `pi-agent`, `pi-agent-ext-obsidian`, `pi-agent-ext-file2md` and `pi-agent-ext-knowledge-card` do not declare core-runtime, and the dep-guard rejects an undeclared `@repo` edge. `tests/barrel-surface.test.ts` checks BOTH directions — an unsanctioned re-export fails, and so does a facade entry whose named peer has moved off the barrel.
_Avoid_: re-exporting a core-runtime symbol "for convenience" (the barrel reached 114 names of which 21 were ever imported); importing through this package's own barrel from inside `src/`.

### Supporting concepts

**Agent registry** (`loadAgentRegistry` / `AgentDefinition`):
The `.pi/agents/*.md` definition store — name/description/tools/model/prompt/worktree-isolation per named agent type. Resolved via `agentType` on the `subagent` tool and `agent()`; explicit call-site `model`/`tools`/`excludeTools` override the binding. Bundled agents in a workflow pack register per-run with project > pack > user precedence.
_Avoid_: conflating with the in-flight registry (the agent registry is definitions; the in-flight registry is running instances).

**Model tier / model role** (`loadModelTierConfig` / `resolveTierModel` / `resolveModelRole`):
The two model-resolution dimensions, driven by ONE config file: `~/.pi/workflows/model-tiers.json` (`{ tiers, capabilities }`, editable via `/workflows-models`). `tiers` maps a named tier (small/medium/big) → model-spec; `capabilities` maps a capability key (e.g. `vision`) → model-spec. The two dimensions are INDEPENDENT by design — switching text-LLM tiers (e.g. the default provider ↔ a token-exhaustion fallback) must never touch vision, which is always a separate (often local) model since most text-LLM providers cannot do vision. Resolution precedence on a dispatch: explicit `model` > `capability`-resolved > `tier`-resolved > session `mainModel` default.
_Avoid_: **hardcoding model ids ANYWHERE in code** — model ids differ per working environment (the local vision model, the default text-LLM provider, the fallback provider are all machine-specific). Resolve every model from config (`tiers` / `capabilities`); config files (`~/.pi/workflows/model-tiers.json`, `~/.pi/agent/models.json`) are the ONLY place env-specific model ids may live. This applies to agent definitions too — reference `tier`/`capability`, never a literal id. (Audit 2026-07-26: subagent src is clean — no hardcoded model-id values.)

**Worktree isolation** (`createWorktree` / `removeWorktree`):
Git-worktree-based isolation for a subagent that should not touch the parent's working tree. An agent definition opts in; the runner creates a linked worktree for the run and removes it after.
_Avoid_: "container" (it is a git worktree, not an OS container).

## Ownership boundary (why this package exists)

This package owns: the `subagent` + `subagent_runs` TOOLS, the `WorkflowAgent` runner, `spawnSubagent`, the singletons, agent-registry, model-tier, worktree, errors, history helpers, the SDD-report parser, **and (since PR #821 / [ADR-0002](docs/adr/0002-relocate-viewer-command-to-subagent.md)) the `/subagents` interactive TUI viewer + slash command + the progress widget**, plus the shared agent-row render helpers (`src/agent-row-display.ts`).

It does NOT own: the `workflow`/`workflow_control`/`workflow_help` tools or the workflow orchestration engine (those live in `pi-agent-ext-workflow`). The viewer/command originally stayed in workflow ([ADR-0001](docs/adr/0001-why-extracted.md)) due to a `display.ts ⟹ workflow.ts` cycle; #821 broke that cycle by extracting the generic render helpers into this package's `agent-row-display.ts`, so the viewer now imports only local code.
