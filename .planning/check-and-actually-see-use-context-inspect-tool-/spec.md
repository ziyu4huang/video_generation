# Spec — superpowers ↔ workflow subagent bridge

> Source: wayfinder map `.planning/check-and-actually-see-use-context-inspect-tool-/` (tickets 01
> closed, 02 closed: **Shape A, minimal v1**). Synthesized by `to-spec` — no interview, just the
> agreed decisions.

## Problem Statement

An agent following superpowers' `subagent-driven-development` (SDD) or
`dispatching-parallel-agents` skills cannot actually dispatch a subagent in this repo. SDD's
dispatch template (`Subagent (general-purpose): …`) resolves, on Pi, to *"use an installed
`subagent` tool if available; else execute in-session."* No `subagent` tool is installed here
(`inspect_extensions` confirms), so every SDD dispatch silently degrades to running in the parent
session — defeating SDD's core premise (isolated context per task). The engine to run an isolated
child already exists in `pi-agent-ext-workflow` (`spawnSubagent()` → `WorkflowAgent.run`), but it
is a programmatic API with no agent-callable surface.

## Solution

Register a `subagent` tool **inside `pi-agent-ext-workflow`** that wraps `spawnSubagent()` with
SDD's single-agent dispatch contract. An agent (or SDD) calls
`subagent({ task, model, cwd, tools, excludeTools })`; the tool spawns an isolated-context child
via `spawnSubagent()` and returns the child's output plus an exit/timed-out status. Point
superpowers' pi-mapping at this tool so the bootstrap tells the agent where to dispatch.

## User Stories

1. As an agent using SDD, I want to call a `subagent` tool to dispatch an implementer, so that the
   implementer runs in an isolated context that does not pollute my coordination context.
2. As an agent using SDD, I want to choose the implementer's model per dispatch, so that I can use
   a cheap model for mechanical tasks and a capable model for judgment tasks.
3. As an agent using SDD, I want the subagent's full report returned to me, so that I can read its
   status (DONE / BLOCKED / NEEDS_CONTEXT) and act on it.
4. As an agent using `dispatching-parallel-agents`, I want to issue several `subagent` calls in one
   response, so that independent investigations run concurrently.
5. As an agent dispatching a subagent, I want to restrict the child's tools (allowlist / denylist),
   so that a reviewer can't mutate code or an explorer can't write.
6. As an agent dispatching a subagent, I want the child to inherit the parent's extension tools, so
   that a subagent can use the same `read`/`edit`/`bash` and installed extensions I have.
7. As the repo owner, I want the superpowers bootstrap to tell the agent about this `subagent`
   tool, so that SDD dispatches stop falling back to in-session execution.
8. As a developer, I want the new tool unit-tested with an injectable runner, so that tests do not
   spawn real child sessions.
9. As a developer, I want the tool registered and active like the existing `workflow` tool, so that
   it appears in the agent's available tools without extra activation steps.
10. As a developer, I want a failed/timed-out subagent reported clearly (exit code + stderr), so
    that the parent agent can escalate (re-dispatch with more context / a stronger model).

## Implementation Decisions

- **Shape A — tool lives inside `pi-agent-ext-workflow`.** New module `src/subagent-tool.ts`
  exporting `createSubagentTool(options)` returning a `ToolDefinition`. Registered in
  `extensions/workflow.ts` alongside `workflowTool` / `workflowHelpTool`; made active in
  `session_start` via `pi.setActiveTools(...)`, mirroring the existing `workflow` tool wiring.
- **Tool name `subagent`, label `Subagent`.** Workflow **owns** this name in this repo (real
  `pi-subagents` is a sibling reference, not installed → no collision). Recorded as a known
  constraint: installing real `pi-subagents` later would collide on the `subagent` tool name.
- **Parameters (minimal v1):** `{ agent?, task, model?, cwd?, tools?, excludeTools? }` — a TypeBox
  schema. `task` is the self-contained prompt (required). `agent` is an informational role label
  (e.g. `"implementer"`), forwarded as an instructions prefix. `model`/`cwd`/`tools`/`excludeTools`
  map straight onto `spawnSubagent()`.
- **Execute** maps params → `spawnSubagent({ task, tools, excludeTools, model, cwd, instructions,
  extensionTools })` and returns `{ content: [{type:"text", text}], details: { exitCode, timedOut } }`.
  On success, `text` = the child's output. On failure/timeout, `text` = a short status line + stderr
  (+ any partial output). Report-back *status* (DONE/BLOCKED/…) stays a **prompt convention** — the
  child writes it into its output; SDD's `NEEDS_CONTEXT` loop is handled by the parent re-dispatching.
- **Extension-tools bridging:** the tool reads parent-session tools via an injectable
  `getExtensionTools?: () => ToolDefinition[] | undefined` option. `extensions/workflow.ts` threads
  the **same** `pi.getAllToolDefinitions()` capture it already takes for `manager.setExtensionTools()`
  into the subagent tool (a shared holder updated in `session_start`).
- **No background/async, no clarify-TUI, no acceptance/turnBudget/toolBudget in v1.** The tool
  blocks until the child returns (foreground), matching SDD's synchronous dispatch-review loop.
- **superpowers mapping update:** edit `piToolMapping()` in
  `pi-agent-ext-superpowers/src/superpowers.ts` and the table row + "Subagents" section in
  `skills/using-superpowers/references/pi-tools.md` to point at the workflow-provided `subagent`
  tool. Rebuild superpowers (`bun run build`).

## Testing Decisions

- **Primary seam (highest, mirrors `tests/spawn-subagent.test.ts`):** unit-test
  `createSubagentTool` with an **injectable `spawn`** function (the factory accepts
  `options.spawn ?? spawnSubagent`), so tests assert param-mapping + result formatting without
  spawning a real child. This is the same injection pattern `spawnSubagent` itself uses
  (`options.agent`).
- **Factory-shape tests (mirror `tests/workflow-tool.test.ts`):** assert `name === "subagent"`,
  `label`, `parameters` defined, `execute` is a function, `promptSnippet` truthy.
- **Extension-tools threading:** one test asserts `getExtensionTools()` result is forwarded into the
  `spawn` call's `extensionTools`.
- **Failure formatting:** one test each for timeout (`timedOut:true`) and non-zero exit, asserting
  the returned text includes the status + stderr.
- **Integration (existing harness):** extend `tests/workflow-tools-available.test.ts` (or its
  sibling) to assert the `subagent` tool is registered+active after the extension loads.
- **E2E (manual, final task):** run a real SDD-style dispatch end-to-end and confirm an isolated
  implementer runs and reports back. Not automated in v1.

## Out of Scope

- Porting `pi-subagents` breadth: chains, async/background, watchdog, intercom, scheduled runs,
  dynamic fanout, `parallel`/`chain` modes, `clarify`-TUI, `acceptance`, `turnBudget`, `toolBudget`.
- The delegation event-bus protocol (Shape B) and a separate adapter extension (Shape D).
- Editing SDD's skill markdown / dispatch template — the `Subagent (general-purpose):` contract is
  the fixed target; we meet it, not lower it.
- Coexistence machinery for a future real `pi-subagents` install (recorded as a known constraint).

## Further Notes

- Dogfooding: once landed, SDD can execute its own plans on this repo via this tool — the bridge
  enables its own executor.
- `spawnSubagent()` is already consumed by `zk_card` / `zk_ask`; the new tool is a second, agent-
  facing caller over the same engine — no engine changes required.
- Per CLAUDE.md: Bun only (test via `bun test` from `bun-apps/pi-agent-ext-workflow`); written
  artifacts in English; no top-level `cd`.
