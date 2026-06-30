# bun-pi-agent-sdk-demo

Drive **pi-agent as a library** via the SDK (`@earendil-works/pi-coding-agent`)
from TypeScript, run with **Bun**'s native TS runtime. All modes share one
unified CLI.

## Build & protection tiers

Three build tiers, from weakest to strongest source protection:

```bash
bun run build      # bundle + minify + external sourcemap → ../dist/<app>/cli.js
bun run build:obf  # + javascript-obfuscator (control-flow, strings)
bun run build:exe  # + bun --compile → standalone executable (bytecode)
bun run build:all  # minify → obfuscate → compile
```

Output goes **one level up**, namespaced by app name (`../dist/bun-pi-agent-sdk-demo/`).

| Tier | Output | Protection | Note |
|------|--------|-----------|------|
| `build` | `../dist/<app>/cli.js` (6.7 MB) | low | names mangled; trivially unminified |
| `build:obf` | `../dist/<app>/cli.js` | medium | self-defending + flattened control flow |
| `build:exe` | `../dist/<app>/<app>` (75 MB) | medium-low | minified JS embedded as plaintext strings; extractable with `strings` |

> ⚠️ `build:obf` currently **auto-falls-back to minified** because
> `javascript-obfuscator`'s parser chokes on Unicode-property regexes
> (`\p{...}`) inside bundled deps. The pipeline catches this and keeps the
> minified `../dist/<app>/cli.js`.
>
> ⚠️ **`build:exe` does not encrypt your source.** `bun --compile` bundles
> runtime + source into one binary, but the minified JS is present as
> plaintext strings inside `../dist/<app>/<app>` and recoverable with `strings`.
> Tokens like `get_uptime`, `"rm -rf blocked"`, and the HELP text are all
> extractable. There is **no high-protection tier** in this pipeline.
> For real secrecy, move sensitive logic to a server-side API.

Run artifacts:
```bash
bun ../dist/bun-pi-agent-sdk-demo/cli.js ext "List files"   # minified/obfuscated bundle
./../dist/bun-pi-agent-sdk-demo/bun-pi-agent-sdk-demo ext "List files"   # standalone executable
```

> 🔒 **Build output (`../dist/<app>/`) is for debugging only — do not distribute to users.**
> See `../dist/<app>/README.md` (auto-generated each build). Sourcemaps reverse
> minification and obfuscation entirely and reconstruct your original source.

## Setup

```bash
bun install
```

Model/credentials come from your existing pi config
(`~/.pi/agent/settings.json`, `auth.json`, `models.json`).
Your current default is `zai / glm-5.2`.

## Unified CLI

```bash
bun run cli <mode> [prompt]
```

│ Mode | What it does |
|------|--------------|
| `minimal` | All defaults — simplest possible usage |
| `full` | Explicit model, no resource discovery |
| `tools` | Custom tool `get_uptime` the agent can call |
| `ext` | Inline extension: event logging, bash gate, custom tool `ping`, `/hi` command |
| `sub` | **Parent agent with `subagent` tool** — delegates tasks to specialized isolated sub-agents |
| `chat` | Interactive multi-turn REPL **with persistent session resume** (like TUI); `-p`/`--print` for non-interactive batch |
| `version` | Print the CLI version (also `--version` / `-v`) |
| `list` | List available models (with valid credentials) |
| `agents list` | List discovered sub-agent definitions |

### Examples

```bash
bun run minimal                # uses default prompt
bun run minimal "List files"
bun run full    "List files"
bun run tools   "Call get_uptime and run ls"
bun run ext     "Call ping then run ls"
bun run sub     "Delegate to scout: list files in src/"   # parent → sub-agent
bun run agents list                                         # show defined sub-agents
bun run chat                   # interactive (resumes last session)
bun run chat --new             # force a fresh session
bun run chat -p "Summarize this"   # non-interactive print mode (persists)
echo "notes" | bun run chat -p "Summarize"   # merge piped stdin
bun run chat --list           # show sessions for this directory
bun run chat --session <id>   # resume a specific session
bun run chat --no-idle-timeout # disable auto-exit (default: 15s)
bun run version                # print the CLI version
bun run list
```

`bun run cli` with no args (or `help`) prints usage. `--version` / `-v` works too.

### REPL slash commands

Inside `bun run chat`, the following slash commands are available:

| Command | Action |
|---------|--------|
| `/help` | List available slash commands |
| `/clear` | Clear the terminal screen |
| `/exit`, `/quit` | Quit the REPL (same as Ctrl+D) |

## Sub-agents

This app demonstrates pi's sub-agent model, adapted to use **its own CLI**
as the delegation target (instead of spawning `pi`).

### How it works

1. **Agent definitions** = Markdown files with YAML frontmatter, discovered
   from `.pi/agents/*.md` (project) and `~/.pi/agent/agents/*.md` (user):
   ```markdown
   ---
   name: scout
   description: Fast read-only codebase recon
   tools: read, grep, find, ls, bash
   ---
   <system prompt body>
   ```
2. **The `subagent` tool** (`src/subagent-tool.ts`) is a custom tool registered
   on the parent session. When the LLM calls it, it spawns **this app's own CLI**
   in an isolated print-mode session:
   ```
   bun src/cli.ts chat -p --new "<system prompt>\n\nTask: <task>"
   ```
   Each sub-agent gets a fresh isolated context (`--new`), restricted tools
   (via `PI_TOOLS` env), and its system prompt prepended to the task.
3. **Modes**: `single {agent, task}` · `parallel {tasks:[…]}` · `chain {chain:[…]}`
   (chain supports a `{previous}` placeholder for the prior step's output).

### Define a sub-agent

Create `.pi/agents/my-agent.md`:
```markdown
---
name: my-agent
description: What this agent does
tools: read, grep
---
You are a specialized agent…
```

### Invoke

```bash
bun run sub "Use the subagent tool to delegate to 'scout': find all TODO comments"
bun run agents list   # see discovered agents
```

The parent agent will call `subagent`, which spawns an isolated `chat -p --new`
session with the scout's config and returns the result.

## Layout

```
src/
├── cli.ts                      # unified entry — hierarchical sub-command registry
├── minimal.ts                  # standalone minimal (kept as a one-liner reference)
├── preflight.ts                # runtime pre-checks (run source, sourcemap, model)
├── subagent-tool.ts            # custom `subagent` tool → spawns isolated sessions
├── sessions/
│   ├── shared.ts                      # shared LLM config + createSharedSession()
│   ├── session-store.ts               # persistent session resume helpers
│   ├── full-control-session.ts        # buildFullControlSession()
│   ├── custom-tools-session.ts        # buildCustomToolsSession()
│   ├── inline-extension-session.ts    # buildInlineExtensionSession()
│   ├── subagent-session.ts            # buildSubagentSession() (parent + subagent tool)
│   └── chat-loop.ts                   # chatLoop() (REPL + print mode + resume)
└── __tests__/                  # unit tests (Bun test) for pure logic
    ├── chat-loop.test.ts              #   truncate / extractText / formatHistoryLine
    ├── cli.test.ts                    #   command resolver + parseChatFlags
    └── subagent-tool.test.ts          #   extractFinalAssistantText (NDJSON)

.pi/agents/                  # sub-agent definitions (scout.md, worker.md)
../dist/<app>/                # ⚠️ build artifacts — debug only, never distribute (auto-gen README per build)
```

**Build/run separation:** each `sessions/*.ts` exports a *session builder*
(`() => Promise<CreateAgentSessionResult>`). `cli.ts` owns the shared runner
(`attachStreamer` + `session.prompt`) so every mode streams consistently.

## How the SDK wiring works

1. A builder calls `createAgentSession({...})` → returns `{ session, ... }`.
2. `cli.ts` attaches a subscriber that prints text deltas + tool activity.
3. `session.prompt(text)` drives one user turn; resolves when idle.
4. `session.dispose()` tears it down.

Node.js works too: `npx tsx src/cli.ts minimal`. Bun is used here because it
runs `.ts` natively with zero config.

## Tests

Unit tests cover the CLI's pure logic (no network, no model calls):
command routing/`resolve`, flag parsing (`parseChatFlags`), history
formatting (`truncate`/`extractText`/`formatHistoryLine`), and NDJSON
extraction (`extractFinalAssistantText`).

```bash
bun test                 # run the suite
bun test src/__tests__/  # scope to a path
```

To keep modules import-safe, `cli.ts` only runs `main()` when it is the
entry point (`import.meta.main`), and the pure helpers are exported.
