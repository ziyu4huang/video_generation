# Prompt templates vs prompt guidelines ("promptGuide")

pi has **two unrelated concepts** that both get called "prompt guide(s)". They
live in different subsystems, are loaded differently, and have different
visibility to extensions. This doc disambiguates them and documents the
template discovery logic (since templates are not API-exposed — see
`pi-internals.md` §1).

---

## Concept A — Prompt *Guidelines* (per-tool system-prompt bullets)

**What:** short text bullets appended to the *Guidelines* section of the
default system prompt, active whenever the owning tool is active.

**Where defined:** `ToolDefinition.promptGuidelines?: string[]`
(`dist/core/extensions/types.d.ts`). Aggregated at prompt-build time into
`BuildSystemPromptOptions.promptGuidelines: string[]`
(`dist/core/system-prompt.d.ts`).

```ts
defineTool({
  name: "todo",
  description: "...",
  parameters: Type.Object({}),
  promptSnippet: "Manage a task list for tracking multi-step progress", // one-liner
  promptGuidelines: [                                                  // bullets
    "Use `todo` for complex work with 3+ steps ...",
    "When starting any task, mark it in_progress BEFORE beginning work ...",
  ],
  async execute(...) { ... },
});
```

**Visibility to extensions:** ✅ fully accessible.
- Per-tool: `pi.getAllTools()` → each `ToolInfo.promptGuidelines` + `sourceInfo`.
- Aggregated: `BuildSystemPromptOptions.promptGuidelines` (via `before_agent_start`
  snapshot or `ExtensionCommandContext.getSystemPromptOptions()`).

**Already reported by `context_analyzer`** (the "Guidelines" section) — so it
is NOT a new capability. `context-analyzer-extension.md` notes making it a
dedicated filterable sub-tool is low-value.

---

## Concept B — Prompt *Templates* (markdown `/command` files)  ← the useful one

**What:** standalone markdown files invocable as `/name args` from the input
box. pi expands them into user-message text (argument substitution supported).

**Shape** (`dist/core/prompt-templates.d.ts`):

```ts
interface PromptTemplate {
  name: string;          // filename without .md
  description: string;   // frontmatter.description OR first non-empty body line (≤60 ch)
  argumentHint?: string; // frontmatter["argument-hint"]
  content: string;       // markdown body (after frontmatter)
  sourceInfo: SourceInfo;// source="local"; scope = user|project; baseDir = prompts dir
  filePath: string;      // absolute path to the .md file
}
```

**File format:**

```markdown
---
description: Review a pull request end-to-end
argument-hint: <pr-url>
---
You are a meticulous code reviewer. Review the PR at $1 ...
```

Frontmatter keys: `description`, `argument-hint`. Name is always the filename
(minus `.md`) — there is **no `name:` frontmatter key**. Body supports
`$1 $2 …` positional args, `$@`/`$ARGUMENTS` (all), `${N:-default}`,
`${@:N}`, `${@:N:L}` (`dist/core/prompt-templates.js` `substituteArgs`).

### Discovery — which dirs pi scans

From `loadPromptTemplates()` in `dist/core/prompt-templates.js`:

| Scope | Directory | Notes |
|---|---|---|
| **user (global)** | `<agentDir>/prompts/` | `agentDir` = `~/.pi/agent` (or `$PI_CODING_AGENT_DIR`) |
| **project** | `<cwd>/.pi/prompts/` | `CONFIG_DIR_NAME` = `.pi` (default; `pkg.piConfig.configDir` can override) |
| **explicit** | any path in `promptPaths` | sourced from extensions' `resources_discover` return + `additionalPromptTemplatePaths` |

Only `*.md` files are loaded (case-sensitive extension). Symlinks are followed
for file detection. Each dir is read non-recursively (top-level `*.md` only).
Read errors are silently skipped.

`sourceInfo` synthesis (in `loadPromptTemplates`):
- under global dir → `{ source:"local", scope:"user", baseDir: globalDir }`
- under project dir → `{ source:"local", scope:"project", baseDir: projectDir }`
- otherwise → `{ source:"local", baseDir: <dir of file> }`

### Visibility to extensions

❌ **NOT exposed.** Templates live on `AgentSession.promptTemplates`
(getter → `_resourceLoader.getPrompts().prompts`, `agent-session.js:626`),
and neither `AgentSession` nor `ResourceLoader` is handed to extensions.

❌ **Not deep-importable either.** `loadPromptTemplates` lives in
`dist/core/prompt-templates.ts`, but `package.json` `exports` only maps `.` and
`./rpc-entry` — so `@earendil-works/pi-coding-agent/core/prompt-templates.ts`
is **blocked by the exports map** (Node/Bun enforce it).

✅ **The only way to list them from a tool is to re-scan the same dirs
ourselves** (global + project; extension `promptPaths` from other extensions'
`resources_discover` are not capturable by a peer extension). This is what the
planned `prompt_list` sub-tool does — see `context-analyzer-extension.md`.

### When templates are expanded

`AgentSession` runs `expandPromptTemplate(text, templates)` on user input
(`agent-session.js:764,926,943`) before the agent loop. If the first token
matches a template name, the body (with arg substitution) replaces the input.
Templates therefore behave like user-authored slash commands and do **not**
appear in the system prompt.

---

## TL;DR decision table

| You want to list… | API path | New tool needed? |
|---|---|---|
| prompt **guidelines** | `getAllTools()` → `.promptGuidelines` (+ `sourceInfo`) | No — `context_analyzer` covers it |
| prompt **templates** (`/cmd` files) | none — re-scan `<agentDir>/prompts` + `<cwd>/.pi/prompts` | **Yes** → `prompt_list` |
| extensions | derive from `getAllTools()`+`getCommands()` `sourceInfo` | **Yes** → `extension_list` |
| skills | `BuildSystemPromptOptions.skills` (before_agent_start snapshot) | optional |
