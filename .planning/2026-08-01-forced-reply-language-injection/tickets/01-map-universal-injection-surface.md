# 01 — Map the universal injection surface

type: research
claimed: claude (chart-the-map session, 2026-08-01)
closed: 2026-08-01

## Question

Is there a **single chokepoint** that every session-creation path (main,
subagent subprocess, workflow agent, obsidian-child) flows through for system
prompt assembly — and if so, what are the levers for injecting a FORCED,
high-priority block that reaches all of them? (This is the foundation: every
implementation choice depends on it.)

## Resolution

**Yes — there is a universal seam.** Verified in
`@earendil-works/pi-coding-agent@0.83.0` `dist/`:

### The universal path

1. **`ResourceLoader`** (`dist/core/resource-loader.js`) is constructed by every
   `AgentSession`. `loadProjectContextFiles(options)`:
   - loads the **global** context file from `resolvedAgentDir`
     (= `~/.pi/agent/AGENTS.md`) — **line 86, unconditional**;
   - walks ancestors from `cwd` loading `AGENTS.md`/`CLAUDE.md`
     (`loadContextFileFromDir`, line 31: candidates `AGENTS.md`/`CLAUDE.md`).
2. **`AgentSession._rebuildSystemPrompt`** (`dist/core/agent-session.js:710`)
   pulls from the loader:
   - `loaderSystemPrompt` ← `getSystemPrompt()` → `customPrompt`
   - `loadedContextFiles` ← `getAgentsFiles()` → `contextFiles`
   - `appendSystemPrompt` ← `getAppendSystemPrompt().join("\n\n")`
   - `skills`, `toolSnippets`, `promptGuidelines`
   …then calls **`buildSystemPrompt(options)`** (`dist/core/system-prompt.js:7`).
3. **Every session type flows through this:**
   - main CLI session → `runAgentSession` → `AgentSession`
   - subagent → `spawnSubagentSubprocess` → a fresh `pi` subprocess (no
     `--agent-dir`, so default `~/.pi/agent/`) → its own `AgentSession`
   - workflow agent → `WorkflowAgent` → `createAgentSession` → `AgentSession`
   - obsidian/zk children → `createAgentSessionFromServices` (shared.ts) → `AgentSession`

### Key implication (corrects the prior audit)

The global `~/.pi/agent/AGENTS.md` — which already contains the reply-language
rule — **is loaded as a `contextFile` in every session**, including subagent
subprocesses. The rule **propagates**. The defect is that a `contextFile` is
low-priority / drift-able and loses to the strong role-label
`--append-system-prompt` ("You are the implementer…") + the model's English
default.

### Forcing levers (all reach every session by construction)

| Lever | Where | Priority | Notes |
|-------|-------|----------|-------|
| `customPrompt` / `getSystemPrompt()` | loader → `buildSystemPrompt` `customPrompt` arg | **Top** (base prompt, before tools/context) | Cleanest "force inject at the head" |
| `appendSystemPromptOverride` | `ResourceLoader` option (`resource-loader.d.ts:118`: `(base: string[]) => string[]`) | Append section | Designed override hook; sits in the append block |
| `buildSystemPrompt` itself | `system-prompt.js:7` | Anywhere we place it | Most invasive; touches the assembler |

### Setting source

`~/.pi/agent/settings.json` is already read by pi (for `theme`, `defaultModel`,
`defaultThinkingLevel`, …). Adding a `responseLanguage` key there and reading it
inside the chosen lever is consistent with existing config plumbing.

**Assets:** none beyond this ticket.
