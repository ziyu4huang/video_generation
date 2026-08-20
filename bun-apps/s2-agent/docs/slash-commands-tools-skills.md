# Slash Commands, Tools, Skills, Extensions — How They Relate

> Study notes, written 2026-07-15. `s2-agent` itself ships no slash-command
> engine — it's a thin wrapper (see [`../PRD.md`](../PRD.md)) around
> `@earendil-works/pi-coding-agent`. The engine, and every concrete
> `/command`, lives in that SDK plus the sibling `bun-apps/s2-agent-ext-*/`
> workspace packages loaded via `run-dir/manifest.json` (see
> [`extension-registry.PRD.md`](./extension-registry.PRD.md) for how those
> packages get loaded at all). This doc is about what runs *after* loading:
> how a `/foo` in the TUI resolves to code.

## 1. Four names, three mechanisms

| Name | What it is | Who invokes it | Defined as |
|------|-----------|-----------------|------------|
| **Extension** | The loading unit — a TS module exporting `(pi: ExtensionAPI) => void` | pi at startup, via `run-dir/manifest.json` | a workspace package's `extensions/*.ts` |
| **Tool** | LLM-callable function, schema-validated | the LLM, mid agent-loop | `pi.registerTool({ name, ... })` inside an extension factory |
| **Command** | User-typed `/name`, intercepted before the agent loop starts | the user (or `ctx.sendUserMessage("/cmd")`) | `pi.registerCommand(name, { handler })` inside an extension factory |
| **Skill** | Markdown directory (`SKILL.md` + assets), progressive-disclosure content | the LLM (auto) or user (`/skill:name`, forced) | a `skills/<name>/SKILL.md` dir, declared in manifest `skills[]` |

Extensions are the umbrella; tools, commands, and skill-registration are things
an extension's factory *does*. All three can be — and often are — registered
from the same factory function (see `pi-obsidian` in §4).

## 2. Command dispatch: input pipeline

On user input, the SDK checks (in order):

1. **Leading token matches a registered command name** → that command's
   `handler` runs; nothing else in the pipeline fires. **No LLM call** unless
   the handler itself starts one (e.g. spawns an agent subrun/workflow).
2. Otherwise the `input` event fires (extensions can intercept/transform).
3. Otherwise `/skill:name` expands to the skill's full `SKILL.md` content.
4. Otherwise `/template` prompt-template expansion.
5. Otherwise normal agent processing (`before_agent_start` → LLM loop, where
   registered **tools** become callable).

So a slash command is resolved by name lookup, entirely client-side, strictly
*before* the LLM is invoked. A tool call, by contrast, only happens *inside*
step 5, chosen by the LLM.

## 3. Definition shapes

**Command** — TS object, not markdown:

```ts
pi.registerCommand("goal", {
  description: "…",
  getArgumentCompletions?: (...) => string[],
  handler: async (args: string, ctx: ExtensionCommandContext) => { ... },
});
```

Required: `handler`. Optional: `description`, `getArgumentCompletions`. `args`
is the raw string after the command name; `ctx` extends `ExtensionContext`
with session-control methods (`ctx.newSession`, `ctx.reload`,
`ctx.waitForIdle`, …).

**Tool** — schema-validated (typebox), separate registry:

```ts
pi.registerTool({ name, description, parameters, handler });
```

**Skill** — a directory, not code:

```
skills/<name>/SKILL.md    # YAML frontmatter: name, description,
                           #   optional license/compatibility/metadata/
                           #   allowed-tools/disable-model-invocation
```

Discovered from `~/.pi/agent/skills/`, `.pi/skills/`, `~/.agents/skills/`,
`.agents/skills/`, a package's own `skills/` dir, or manifest `skills[]`
entries. The SDK auto-registers each as a `/skill:<name>` command — skill
*invocation* reuses the command surface (step 3 above), but skill *content*
is markdown loaded on demand, not a TS handler.

## 4. Concrete examples (file:line)

- **Pure command**: `s2-agent-ext-task/src/goal/goal.ts:331` —
  `pi.registerCommand("goal", { description, getArgumentCompletions:
  completeGoalArguments, handler })`, registered from the default factory
  `export default function goal(pi, overlay)` at `goal.ts:326`. Wired in via
  `"s2-agent-ext-task/extensions/task.ts"` in
  `run-dir/manifest.json`.

- **Command spawning a workflow**:
  `s2-agent-ext-workflow/src/builtin-commands.ts:40` —
  `pi.registerCommand("deep-research", { description, handler: async (args,
  ctx) => { ...runWorkflow(...); pi.sendMessage(...) } })`, inside
  `registerBuiltinWorkflows(pi, opts)` (`:36`). Siblings `adversarial-review`
  (`:65`), `multi-perspective` (`:89`), `codebase-audit` (`:120`) follow the
  same shape — each spawns a sub-agent workflow and posts the result as a
  message, not a tool result (no LLM round-trip needed to report back).

- **Tool + command from one factory**:
  `s2-agent-ext-obsidian/extensions/obsidian.ts:1792` —
  `pi.registerCommand("obsidian", {...})`, plus `obsidian-init` (`:1818`) and
  `obsidian-config` (`:1847`), registered from the same default-export
  factory that also calls `pi.registerTool()` for LLM-facing tools. Shows the
  umbrella pattern from §1 in one file.

## 5. Why this matters for authoring in this repo

- Adding a `/command` never touches `run.py` or the MLX pipeline directly —
  the handler decides whether to shell out, spawn a workflow, or just mutate
  session state. See [`extension-registry.PRD.md §4`](./extension-registry.PRD.md#4-registry-model-how-to-author--register-an-extension)
  for the full "add an extension" checklist (manifest entry, peerDeps,
  `extension-contract.test.ts`).
- A command's `handler` runs untrusted-by-the-LLM, synchronously-to-input —
  good place for guardrails/validation that a tool (LLM-gated) can't enforce
  before execution.
- Skills are the right choice when the payload is *prose the LLM should read*
  (a procedure, a checklist) rather than *code that should run* — that's the
  markdown-directory vs. TS-handler split in §1.

## Cross-reference

- [`../PRD.md`](../PRD.md) — s2-agent's own scope (thin wrapper, deploy modes)
- [`extension-registry.PRD.md`](./extension-registry.PRD.md) — how extensions
  physically load (manifest, peerDeps, jiti/Bun resolution)
