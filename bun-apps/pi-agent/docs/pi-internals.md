# pi-coding-agent internals (for pi-agent & extensions)

Study notes from reading `@earendil-works/pi-coding-agent@0.80.3` source. All
file references are relative to the installed package root:

```
node_modules/.bun/@earendil-works+pi-coding-agent@<ver>+<hash>/node_modules/@earendil-works/pi-coding-agent/
```

> **Re-verify on version bump.** Line numbers and exact strings drift between
> releases. The shapes (interfaces) are more stable than the `.js` line refs.
> Quick check: `bun -e "console.log(require('@earendil-works/pi-coding-agent/package.json').version)"`.

---

## 1. ExtensionAPI surface — what an extension can actually see

Defined in `dist/core/extensions/types.d.ts` → `interface ExtensionAPI`.
This is the `pi` argument passed to every `ExtensionFactory`.

### Enumerable (the ONLY two list methods on the API)

| Method | Returns | Each item carries |
|---|---|---|
| `pi.getAllTools()` | `ToolInfo[]` | `name`, `description`, `parameters`, `promptGuidelines`, **`sourceInfo: SourceInfo`** |
| `pi.getCommands()` | `SlashCommandInfo[]` | `name`, `description?`, `source`, **`sourceInfo: SourceInfo`** |

That's it. There is **no** `getExtensions()`, **no** `getSkills()`, **no**
`getPrompts()` / `getPromptTemplates()` on the public API.

### Other useful (non-list) methods

- `pi.getActiveTools()` / `pi.setActiveTools(names)` — current tool allowlist
- `pi.getFlag(name)` — value of a `registerFlag()` flag
- `pi.setModel(model)` / `pi.getThinkingLevel()` / `pi.setThinkingLevel()`
- `pi.registerTool(def)` / `pi.registerCommand(name, opts)` / `pi.registerShortcut(...)` / `pi.registerFlag(...)` / `pi.registerProvider(name, cfg)`
- `pi.on(event, handler)` — event subscription (see §4)
- `pi.exec(cmd, args, opts)` — shell exec
- `pi.events` — shared `EventBus` for cross-extension messaging

### Encapsulated — NOT reachable from an extension

These exist internally but are hidden behind `AgentSession` / `ResourceLoader`:

| Internal | Where it lives | Why we care |
|---|---|---|
| `LoadExtensionsResult.extensions: Extension[]` | `dist/core/extensions/types.d.ts` | the real extension registry — **not exposed** |
| `AgentSession.promptTemplates` (getter → `_resourceLoader.getPrompts().prompts`) | `dist/core/agent-session.js:626` | loaded `PromptTemplate[]` — **not exposed** |
| `ResourceLoader.getSkills/getPrompts/getThemes/getExtensions` | `dist/core/resource-loader.d.ts` | full resource registry — **not exposed** |

**Implication:** to list *extensions* or *prompt templates* from a tool, we
must either **derive** (from tool/command `sourceInfo`) or **re-discover**
(re-scan the filesystem the way pi does). See `prompt-templates.md` and
`context-analyzer-extension.md`.

---

## 2. SourceInfo — provenance of every tool/command/skill/prompt

`dist/core/source-info.d.ts`:

```ts
type SourceScope  = "user" | "project" | "temporary";
type SourceOrigin = "package" | "top-level";
interface SourceInfo {
  path: string;        // the file that registered the item
  source: string;      // coarse category — see values below
  scope: SourceScope;  // user (global) | project (cwd-local) | temporary (-e flag)
  origin: SourceOrigin;// package (npm/workspace pkg) | top-level (loose file)
  baseDir?: string;    // containing dir for synthetic resources
}
```

### `source` values observed

| `source` | Who sets it | Example `path` |
|---|---|---|
| `"builtin"` | pi core, for read/bash/edit/write/find/grep/ls | `<builtin:read>` (synthetic) |
| `"extension"` | extension loader, for `pi.registerTool/Command` | `…/pi-obsidian/extensions/obsidian.ts` |
| `"local"` | skill/prompt/theme loader (synthetic) | `…/.pi/prompts/commit.md` |
| `"file"` | skills loaded from SKILL.md | `~/.agents/skills/find-skills/SKILL.md` |

Builtins use `createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" })`
(`dist/core/agent-session.js:1874,1902`). `SlashCommandSource` for commands is
the narrower `"extension" | "prompt" | "skill"` (`dist/core/slash-commands.d.ts`).

---

## 3. Tool / command registration & provenance

### Tools

```ts
// dist/core/extensions/types.d.ts
interface ToolDefinition {
  name, label, description, parameters: TSchema;
  promptSnippet?: string;        // one-liner in "Available tools" system-prompt section
  promptGuidelines?: string[];   // bullets appended to system-prompt Guidelines
  executionMode?: "sequential" | "parallel";
  renderShell?: "default" | "self";
  prepareArguments?(args): params;
  execute(toolCallId, params, signal, onUpdate, ctx: ExtensionContext): Promise<AgentToolResult>;
  renderCall?(...); renderResult?(...);
}
defineTool(def) // preserves param typing through arrays/vars
pi.registerTool(def) // sourceInfo attached by the loader automatically
```

Each registered tool is stored as `RegisteredTool { definition, sourceInfo }`
on the `Extension` object; `pi.getAllTools()` flattens these across all
extensions + builtins, each tagged with its `sourceInfo`.

### Commands (slash commands)

```ts
pi.registerCommand(name, {
  description?, handler(args, ctx: ExtensionCommandContext), getArgumentCompletions?,
})
```

`SlashCommandInfo { name, description?, source: "extension"|"prompt"|"skill", sourceInfo }`
is what `pi.getCommands()` returns.

### Key API-vs-context distinction

- **`getAllTools()` / `getCommands()` live on `ExtensionAPI` (`pi`)** — the
  factory arg. They are NOT on `ExtensionContext` (`ctx`) passed to `execute()`
  and event handlers.
- The `pi-agent-ext-power-tool` pattern: capture `pi.getAllTools` as a closure
  in the factory and pass it into each tool's `execute()`.

---

## 4. Events relevant to introspection

`pi.on(event, handler)` — full list in `dist/core/extensions/types.d.ts`.
The ones that matter for snapshotting/diagnostics:

| Event | When | Payload of interest |
|---|---|---|
| `before_agent_start` | after user submits, before LLM loop | `systemPrompt: string`, **`systemPromptOptions: BuildSystemPromptOptions`** |
| `session_start` | startup / reload / new / resume / fork | `reason` |
| `resources_discover` | before resource load (startup/reload) | return `{ skillPaths?, promptPaths?, themePaths? }` to **add** paths |
| `model_select` / `thinking_level_select` | model/thinking change | new + previous |
| `tool_call` / `tool_result` | around every tool | `toolName`, `args`/`result`; can block / mutate |
| `context` | before each LLM call | `messages` (mutable) |

`BuildSystemPromptOptions` (`dist/core/system-prompt.d.ts`) — the structured
breakdown of the system prompt, delivered via `before_agent_start`:

```ts
interface BuildSystemPromptOptions {
  customPrompt?: string;            // replaces default prompt entirely
  selectedTools?: string[];         // active tool allowlist
  toolSnippets?: Record<string,string>; // "Available tools" one-liners
  promptGuidelines?: string[];      // Guidelines-section bullets (aggregated)
  appendSystemPrompt?: string;      // extra text appended
  cwd: string;
  contextFiles?: { path: string; content: string }[]; // e.g. CLAUDE.md
  skills?: Skill[];                 // loaded skills
}
```

> **Prompt templates are NOT in `BuildSystemPromptOptions`.** Templates are
> expanded at input time (`AgentSession`), not part of the system prompt. See
> `prompt-templates.md`.

---

## 5. Resource discovery pipeline (AgentSession → ResourceLoader)

`dist/core/agent-session.js` orchestrates loading on startup/reload:

1. Emit `resources_discover` → collect `{ skillPaths, promptPaths, themePaths }`
   from every extension (`agent-session.js:1691`).
2. `ResourceLoader` merges those with built-in dirs and loads:
   - extensions (`.pi/settings.json` `packages` + additional paths)
   - skills (`loadSkills`)
   - **prompts** (`loadPromptTemplates`) — see `prompt-templates.md`
   - themes
   - context files (`loadProjectContextFiles`)
3. Results are cached on the loader; `getPrompts()`/`getSkills()`/etc. return
   them. `reload()` re-runs the pipeline.

The `ResourceLoader` interface (`dist/core/resource-loader.d.ts`) exposes
`getExtensions()`, `getSkills()`, `getPrompts()`, `getThemes()`,
`getAgentsFiles()`, `getSystemPrompt()`, `getAppendSystemPrompt()`,
`extendResources(paths)`, `reload()` — **but only `AgentSession` holds a
reference; extensions never receive it.**

---

## 6. Modes & context shapes

`ExtensionMode = "tui" | "rpc" | "json" | "print"`.

- `ExtensionContext` (event handlers + `execute()` `ctx`): `ui, mode, hasUI,
  cwd, sessionManager, modelRegistry, model, signal, getContextUsage(),
  getSystemPrompt(), compact(), ...`
- `ExtensionCommandContext extends ExtensionContext`: adds
  `getSystemPromptOptions()` (the live `BuildSystemPromptOptions`),
  `waitForIdle()`, `newSession/fork/navigateTree/switchSession/reload()`.
  → **Only command handlers get `getSystemPromptOptions()` directly.** Event
  handlers receive it via the `before_agent_start` payload instead.

`getContextUsage(): { tokens, contextWindow, percent } | undefined` — null
right after compaction, before the next response.

---

## 7. Practical consequences for pi-agent tooling

1. **Listing extensions** → derive from `getAllTools()` + `getCommands()`,
   group by `sourceInfo.path` where `source === "extension"`. Misses
   extensions that register only events/shortcuts/flags. (No API alternative.)
2. **Listing prompt templates** → not API-accessible; must re-scan the same
   dirs pi scans (see `prompt-templates.md`). Extension-declared `promptPaths`
   from `resources_discover` are not capturable by another extension.
3. **Listing skills** → skills ARE partially visible: each `Skill` in
   `BuildSystemPromptOptions.skills` has `name, description, filePath, baseDir,
   sourceInfo`. So skills are enumerable via the `before_agent_start` snapshot.
4. **Context files & guidelines** → both in `BuildSystemPromptOptions`; this
   is exactly what `context_analyzer` already reports.

See `context-analyzer-extension.md` for how the existing tools use §4's
snapshot, and the design for the new `extension_list` / `prompt_list` sub-tools.
