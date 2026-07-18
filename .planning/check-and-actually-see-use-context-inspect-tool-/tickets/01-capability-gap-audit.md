---
type: research
status: closed
---

# 01 — Capability-gap audit: SDD's subagent needs vs workflow's reality vs pi-subagents' reference

## Question
What does superpowers' SDD / dispatching-parallel-agents require of a "subagent", what does
`pi-agent-ext-workflow` already provide, and what does `pi-subagents` expose that we can learn
the interface from?

## Resolution (closed — researched in the charting session)

### What SDD requires (the FIXED target — we meet it, not edit it)
- **Dispatch surface:** the `Subagent (general-purpose):` text template. On pi,
  `skills/using-superpowers/references/pi-tools.md` tells the agent: *"use an installed
  `subagent` tool such as `subagent` from `pi-subagents` if available; else execute in-session
  or explain the missing capability."* ← the drift lives here: no such tool is installed.
- **Per-dispatch contract** (`implementer-prompt.md`): `description` + `model` (explicit, per
  Model Selection) + `prompt`. The child runs in an **isolated context**, may ask questions,
  and reports back `Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT` + commits +
  one-line test summary + report-file path.
- **Parallel:** `dispatching-parallel-agents` — N independent dispatches in one response run
  concurrently.

### What `pi-agent-ext-workflow` already has (the engine is ~80% there)
- **`spawnSubagent()`** (`src/spawn-subagent.ts`): thin wrapper over `WorkflowAgent.run`
  (in-process `createAgentSession`). Accepts `task`, `tools` (allowlist), `excludeTools`,
  `model`, `schema` (structured output), `instructions`, `cwd`, `timeoutMs`,
  `retryOnTransient`, `extensionTools` (parent-session tools bridged into the child).
  Returns `{output, exitCode, stderr, timedOut}`. → already delivers isolated context +
  model override + tool curation + structured output + cwd + timeout + parent-tool bridging.
  Currently consumed by `zk_card` / `zk_ask`.
- **`workflow` tool** (`src/workflow-tool.ts`): input `{script, name, args, background,
  maxAgents, concurrency, agentRetries, agentTimeoutMs, tokenBudget}` — a JS **workflow-script
  runner**, a *different* abstraction than single-agent dispatch.
- **No `subagent` tool, no delegation-protocol listener.**

### What `pi-subagents` exposes (the reference — learn the interface, don't replicate)
- A **`subagent` tool** (`src/extension/schemas.ts`, `SubagentParams`): `agent, task, model,
  cwd, context(fresh|fork), skill, output, acceptance, turnBudget, toolBudget, clarify(TUI),
  async, tasks[](parallel), chain[](sequential), + management actions`.
- A **decoupled event-bus delegation protocol** (`src/api/delegation.ts` +
  `src/slash/prompt-template-bridge.ts`, `registerPromptTemplateDelegationBridge`): emitters
  fire `SUBAGENT_DELEGATION_REQUEST_EVENT`; the bridge answers by executing a subagent run and
  emitting `SUBAGENT_DELEGATION_RESPONSE_EVENT` / `_UPDATE_EVENT`. Any extension can request;
  any provider can answer.

### The gap (precise)
**The runner exists; the binding surface does not.** SDD's dispatch resolves to neither a tool
call nor a protocol emission today → it falls back to in-session execution. Closing the drift =
adding exactly one binding surface on top of `spawnSubagent()` / `WorkflowManager`. *Which*
surface is [ticket 02](./02-compatibility-shape-decision.md).

### Assets consulted
- `bun-apps/pi-agent-ext-superpowers/src/superpowers.ts`, `…/using-superpowers/references/pi-tools.md`,
  `…/subagent-driven-development/{SKILL.md, implementer-prompt.md}`, `…/dispatching-parallel-agents/SKILL.md`
- `bun-apps/pi-agent-ext-workflow/src/{spawn-subagent.ts, workflow-tool.ts}`
- `/Users/huangziyu/proj/pi-subagents/src/extension/{index.ts, schemas.ts}`, `src/slash/prompt-template-bridge.ts`
