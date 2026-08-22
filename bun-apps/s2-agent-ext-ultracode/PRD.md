# PRD — s2-agent-ext-ultracode

## Problem

One model grinding a task step by step is linear and slow for codebase-wide audits, multi-perspective review, large refactors, or cross-checked research. A single agent context window cannot hold an entire audit surface. Claude Code's dynamic workflow pattern (write a JS orchestration script that spawns subagents) doesn't exist in Pi.

## Solution

Claude Code–style dynamic workflows for Pi. The agent writes a small JavaScript orchestration script that spawns many subagents at once, keeps intermediate work in script variables, and returns only the result. Supports `agent()`, `parallel()`, `chain()`, deterministic gates (retry/loopUntilDry/journaling/resume), and a VSCode workflow editor. Includes a keyword trigger (`/workflows`) and slash commands.

## Tools / Commands

| Tool/Command | Description |
|--------------|-------------|
| `workflow` tool | Execute workflow scripts: `agent()`, `parallel()`, `chain()`, `gate`, `retry`, `loopUntilDry`, `journaling` |
| `subagent` tool | Dispatch one isolated-context subagent outside a script; reports real usage/cost, accepts `timeoutMs`/`retryOnTransient`, `agentType` (named tool/model/prompt/isolation bindings), and `schema` (structured output); streams live progress while running |
| `/workflows run <prompt>` | Force an ad-hoc workflow |
| `/deep-research <topic>` | Multi-perspective research workflow |
| `/adversarial-review` | Cross-checked review workflow |
| `/workflows-trigger set/off/status` | Manage keyword auto-trigger |
| `workflow_control` tool | Model-callable stop/pause/resume/status/list/wait for a background run |

## Key Dependencies

- Self-contained npm package: `npm:@quintinshaw/pi-dynamic-workflows`
- Loaded via s2-agent's run-dir manifest, or headlessly via `s2-agent cli workflow run`

## Architecture — thin adapter, not a parallel LLM stack

This package **delegates its entire LLM / agent / tool layer to Pi** and adds
*only* workflow orchestration on top. It does NOT implement a competing LLM
provider, agent runtime, or tool registry.

- **LLM transport**: every `agent()` call constructs a fresh Pi session via
  `createAgentSession()` and drives it with `session.prompt()`. No `fetch`, no
  provider SDK (`openai` / `@anthropic-ai/sdk` / `@lmstudio/sdk`), no custom HTTP
  path to any LLM exists in this package.
- **Provider / auth / model resolution**: shared — Pi's `ModelRegistry` +
  `AuthStorage` reading the same `~/.pi/auth.json`, `models.json`, and
  `SettingsManager` as every other Pi command. `mainModel` is a `provider/modelId`
  string handed to the session.
- **Tools**: shared — Pi's `ToolDefinition` / `defineTool`, default set
  `createCodingTools(cwd)`. Engine tools (`structured_output`, web fetch, workflow
  trigger, spawn-subagent) are defined via `defineTool` and injected through Pi's
  `customTools` extension point. No second tool registry; no skills/`ToolSearch`.
- **The only runtime dep is `acorn`** (the script parser); the LLM capability
  comes entirely from the peer dep `@earendil-works/pi-coding-agent`.
- **What this package owns**: the workflow control-flow layered on top of those
  sessions — fan-out (`parallel` / `pipeline`), `phase`, deterministic gates
  (`gate` / retry / `loopUntilDry`), journaling, resume, structured-output repair,
  tier routing, and real token/cost accounting read back from each session.

> Design intent: one LLM / agent / tool stack (Pi's). This package is a workflow
> orchestration layer, never a second implementation of the layers below it.

## Workflow packs — two entry paths, one resolver

A **workflow pack** (a `manifest.json` + entry script folder) is the reusable,
named form of a workflow. It is reachable through **two** entry paths that
share a single pack resolver (`workflow-pack.ts` in this package):

- **Path A — CLI**: `s2-agent cli workflow run <name>` (headless meta-command;
  the CLI layer is a thin wrapper — flag parsing + receipt).
- **Path B — interactive tool**: the `workflow` tool's optional `name` parameter
  (mutually exclusive with `script`). The workflow extension is built-in in the
  pi TUI (`./s2-agent.sh`), so any session can resolve + run a pack by name.

Both paths call the same `resolveWorkflowScript` → `runWorkflow`, so name
resolution, pack-over-file precedence, and args merging are identical. The
pack resolver, manifest model, and the `runWorkflowScript` orchestration are
exported from this package and consumed by the CLI (no resolver code lives in
the CLI anymore).

> `manifest.model` is applied on BOTH paths — Path A via `--model` precedence
> (flag > env > manifest > pi default), Path B via `ExecOptions.mainModel`
> (ticket 06). Effective precedence on Path B: script per-agent `model` >
> `manifest.model` > session `mainModel`; the result details label reports
> `modelSource: "manifest"` vs `"session"` accordingly.


## Install

```bash
pi install npm:@quintinshaw/pi-dynamic-workflows
```

## Use

```text
"Run a workflow to audit every route under src/routes/ for missing auth checks."
```

Headless mode:
```bash
bun bun-apps/s2-agent/src/cli.ts cli workflow run <name> [--model <spec>]
```
