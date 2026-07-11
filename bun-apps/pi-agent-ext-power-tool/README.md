# pi-agent-ext-power-tool

A **pi extension** bundle. Originally developer-focused diagnostics, it now
also hosts several always-on agent features, all registered through one
`src/index.ts` factory.

## Feature surface

| Feature | Tool(s) / surface | Notes |
|---------|-------------------|-------|
| Diagnostics | `inspect_agent`, `inspect_context`, `inspect_extensions` | The original purpose — documented ↓ |
| Task tracking | `todo` tool + `/todos` command | In-session, branch-aware steps |
| Structured questions | `ask_user_question` tool | Multi-choice TUI subsystem |
| Goal driving | `/goal` + `goal_complete` | Endurance driver; publishes `isGoalActive` for Plan-A coordination with planning-with-files |
| Side conversation | `/btw` commands | Adapted from pi-btw (MIT) |
| Schema-cost accounting | `./schema-cost` export | Static tool-token estimator (also a publishable package, `pi-schema-cost`) |
| CLI subcommand | `./extensions/cli-subcommand.ts` | Wired into `pi-agent-cli` |

> **Note:** the diagnostics below are this extension's documented public surface.
> The other features (todo / ask-user / goal / btw) are co-bundled for historical
> reasons; the knowledge tools that used to live here were extracted to
> `pi-knowledge-card` (#351/#354). Splitting the remaining features into focused
> extensions is tracked as future work.

## Diagnostic Tools

### `inspect_agent`

Dump agent state to YAML: extensions, tools, skills, context files, model, cwd.
Readable by humans and agents for debugging/analysis.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `output_dir` | string? | `output/pi` | Output directory (relative to cwd) |
| `filename` | string? | `inspect-agent-<timestamp>` | Output filename (without .yaml) |
| `return_content` | boolean? | `false` | Return YAML content instead of writing to file |

**Output format (YAML):**

```yaml
agent:
  app_name: pi
  cwd: /path/to/project
  timestamp: 2025-01-01T00:00:00Z
  mode: tui
  has_ui: true
  is_idle: true
  is_project_trusted: true

model:
  id: claude-sonnet-4-20250514
  name: Claude 4 Sonnet
  provider: anthropic
  reasoning: false
  context_window: 200000
  max_tokens: 16384
  input_types: [text, image]

context_usage:  # null if no context-usage reading is available yet
  tokens: 19924
  contextWindow: 200000
  percent: 10.0

tools:
  - name: inspect_context
    description: Full context window breakdown...
    parameters: {...}
    prompt_guidelines: []
    source:
      source: extension
      scope: user
      origin: top-level
      path: bun-apps/pi-agent-ext-power-tool/src/index.ts
      base_dir: null

skills:
  - name: find-skills
    description: Helps users discover...
    file_path: ~/.agents/skills/find-skills/SKILL.md
    base_dir: ~/.agents/skills/find-skills
    disable_model_invocation: false
    source:
      source: file
      scope: user
      origin: top-level

context_files:
  - path: CLAUDE.md
    chars: 16984
    estimated_tokens: 4590

guidelines:
  - Use bash for file operations...
  - Use read to examine files...

tool_snippets:
  read: "Read a file..."
  bash: "Execute bash commands..."
```

**Usage:**

```bash
# Default: write to <cwd>/output/pi/inspect-agent-<timestamp>.yaml
call inspect_agent

# Custom output directory
call inspect_agent output_dir="debug/state"

# Custom filename
call inspect_agent filename="my-session-state"

# Return YAML content to LLM instead of writing file
call inspect_agent return_content=true
```

**Working directory detection:**

Pi does not have a dedicated `CLAUDE_PROJECT_DIR` environment variable. Instead:
- **`ctx.cwd`** provides the current working directory in `ExtensionContext`
- All extension tools receive `ctx.cwd` indicating where pi was launched
- This is the project root for file operations

The output path is computed as `<ctx.cwd>/<output_dir>/<filename>.yaml`.

---

### `inspect_context`

Reports a full breakdown of what is consuming the context window before the agent even starts working.

**Output sections:**

| Section | What it measures |
|---|---|
| Live context window | Actual tokens used / context window + fill bar |
| System prompt total | Total chars + estimated tokens (chars ÷ 4) |
| Skills (top 3) | Each skill's formatted XML size, % of total skill block |
| Tools (top 3) | Each tool's schema + description + guidelines chars |
| Context files | Every loaded file (CLAUDE.md etc.) sorted by size |
| Guidelines | All `promptGuidelines` bullets from all active tools |
| Appended system prompt | Extra text appended by extensions |

The tool calls `getSystemPromptOptions()` and `getSystemPrompt()` on the execution context at runtime (`ctx.getSystemPromptOptions()`), then reports all sizes plus the live `ctx.getContextUsage()` reading. No `before_agent_start` snapshot needed — the SDK exposes this data via the tool execution context directly.

**Note:** `getAllTools()` is on `ExtensionAPI` (`pi` in the factory), not on `ExtensionContext` (`ctx` in `execute()`). The factory passes it into the tool via closure.

---

### `inspect_extensions`

Lints the **currently-loaded extensions, tools, skills, and prompt-guidelines** for potential issues — the diagnostic the other two tools don't provide. While `inspect_context` measures token distribution and `inspect_agent` dumps state, `inspect_extensions` flags concrete problems an extension author or maintainer should act on.

**Checks** (severity → id):

| Sev | Check | Flags |
|-----|-------|-------|
| 🔴 high | `duplicate-tool-name` | Same tool name registered from ≥2 sources (silent override / `Tool "x" conflicts`) |
| 🔴 high | `missing-description` | Tool with empty/whitespace description (model can't discover it) |
| 🟡 medium | `missing-snippet` | Tool absent from the Available-tools list (no `promptSnippet`) |
| 🟡 medium | `oversized-tool-schema` | Tool API schema (desc + params) above threshold — cost repeats every request |
| 🟡 medium | `oversized-skill` | Formatted skill above the char threshold |
| 🟡 medium | `oversized-context-file` | Context file (e.g. CLAUDE.md) above the char threshold |
| 🟢 low | `stale-guideline-ref` | A guideline references a backticked `` `tool` `` that isn't registered |
| ℹ️ info | `no-guidelines` | Non-builtin tool with zero `promptGuidelines` — **informational only** (guidelines are optional in the SDK and a context *cost*; not counted as an issue) |
| ℹ️ info | `extension-token-tax` | Per-extension est. tok/req (non-builtin tools, grouped by source) + total |

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `return_json` | boolean? | `false` | Return machine-readable `{findings, summary, total_extension_tokens}` JSON instead of a text report |
| `tool_token_threshold` | number? | `1500` | Flag tools whose API schema exceeds this many tokens |
| `skill_char_threshold` | number? | `2000` | Flag skills whose formatted size exceeds this many chars |
| `context_file_char_threshold` | number? | `20000` | Flag context files exceeding this many chars |

**Output:** a severity-ranked report (clean message when zero actionable issues) followed by an **Extension token tax** table showing which extension contributes the most token cost per request, sorted desc with a % bar.

**Usage:**

```bash
# Text report against the repo's own extensions (auto-loaded via run-dir):
bun bun-apps/pi-agent/src/cli.ts --model google/gemma-4-26b-a4b-qat \
  -p "call inspect_extensions"

# Machine-readable JSON:
# call inspect_extensions return_json=true

# Tighten thresholds to surface borderline cases:
# call inspect_extensions tool_token_threshold=800 context_file_char_threshold=10000
```

**What it found in this repo (real run):** pi-obsidian's 16 tools have no Available-tools snippets or `promptGuidelines`; `skill_manage` is over the schema threshold (1244 tok); pi-obsidian is the heaviest extension tax (~35%, 3237 tok/req) out of ~9,197 tok/req total across all non-builtin tools.

## Usage

```bash
# One-shot diagnostic (no TUI)
bun bun-apps/pi-agent/src/cli.ts \
  -e bun-apps/pi-agent-ext-power-tool/src/index.ts \
  -p "call inspect_context"

# With another extension to see its contribution
bun bun-apps/pi-agent/src/cli.ts \
  -e bun-apps/pi-agent-ext-power-tool/src/index.ts \
  -e bun-apps/some-other-ext/src/index.ts \
  -p "call inspect_context"

# Interactive TUI session
bun bun-apps/pi-agent/src/cli.ts \
  -e bun-apps/pi-agent-ext-power-tool/src/index.ts
# then type: call inspect_context
```

## Layout

```
pi-agent-ext-power-tool/
├── package.json          # @repo/pi-agent-ext-power-tool
├── extensions/
│   └── cli-subcommand.ts  # pi-agent-cli subcommand wiring
├── docs/                  # extension-analyzer / schema-cost / ui-conventions
└── src/
    ├── index.ts           # ExtensionFactory — registers ALL features below
    ├── schema-cost/       # static tool-token estimator (exported; publishable)
    ├── ask-user/          # ask_user_question tool + TUI subsystem
    ├── goal/              # /goal + goal_complete driver
    ├── todo/              # todo tool + /todos command + overlay
    ├── btw/               # /btw side-conversation feature
    └── shared/            # composite status widget
```

## What the numbers mean

A fresh default pi session in this repo uses **~19,924 tokens (~10.0% of 200k)** before any conversation.
The system prompt alone is **~9,242 tokens** (34,194 chars):

```
CLAUDE.md         16,984 chars   ~4,590 tok   (50% of system prompt)
Guidelines        12,058 chars   ~3,259 tok   (all tool promptGuidelines bullets)
Skills              1,613 chars     ~436 tok
+ base pi prompt + tool snippets + tool schemas in API call
─────────────────────────────────────────────────────────
Total context:    ~19,924 tok    (~10.0% of 200k)
```

Top offenders (from a real run):

| Component | Chars | Est. tokens |
|---|---|---|
| CLAUDE.md | 16,984 | 4,590 |
| All guidelines (53 bullets) | 12,058 | 3,259 |
| `workflow` tool guidelines alone | 7,344 | 1,985 |
| `skill_manage` tool | 5,369 | 1,451 |
| `ask_user_question` tool | 5,000 | 1,351 |
| All skills | 1,613 | 436 |
