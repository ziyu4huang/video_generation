# pi-agent-ext-power-tool

A **pi extension** that adds developer-focused diagnostic tools.

## Tools

### `agent_inventory`

Dump agent state to YAML: extensions, tools, skills, context files, model, cwd.
Readable by humans and agents for debugging/analysis.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `output_dir` | string? | `output/pi` | Output directory (relative to cwd) |
| `filename` | string? | `agent-inventory-<timestamp>` | Output filename (without .yaml) |
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
  context_window: 205000
  max_tokens: 16384
  input_types: [text, image]

context_usage:
  tokens: 19924
  contextWindow: 205000
  percent: 9.7

tools:
  - name: context_analyzer
    description: Full context window breakdown...
    parameters: {...}
    prompt_guidelines: []
    source:
      type: extension
      path: bun-apps/pi-agent-ext-power-tool/src/index.ts

skills:
  - name: find-skills
    description: Helps users discover...
    path: ~/.agents/skills/find-skills/SKILL.md
    when_to_use: "Use when the user asks..."

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
# Default: write to <cwd>/output/pi/agent-inventory-<timestamp>.yaml
call agent_inventory

# Custom output directory
call agent_inventory output_dir="debug/state"

# Custom filename
call agent_inventory filename="my-session-state"

# Return YAML content to LLM instead of writing file
call agent_inventory return_content=true
```

**Working directory detection:**

Pi does not have a dedicated `CLAUDE_PROJECT_DIR` environment variable. Instead:
- **`ctx.cwd`** provides the current working directory in `ExtensionContext`
- All extension tools receive `ctx.cwd` indicating where pi was launched
- This is the project root for file operations

The output path is computed as `<ctx.cwd>/<output_dir>/<filename>.yaml`.

---

### `context_analyzer`

Reports a full breakdown of what is consuming the context window before the agent even starts working.

**Output sections:**

| Section | What it measures |
|---|---|
| Live context window | Actual tokens used / context window + fill bar |
| System prompt total | Total chars + estimated tokens (chars ÷ 3.7) |
| Skills (top 3) | Each skill's formatted XML size, % of total skill block |
| Tools (top 3) | Each tool's schema + description + guidelines chars |
| Context files | Every loaded file (CLAUDE.md etc.) sorted by size |
| Guidelines | All `promptGuidelines` bullets from all active tools |
| Appended system prompt | Extra text appended by extensions |

The tool hooks `before_agent_start` to capture the structured `systemPromptOptions` snapshot, then on call reports all sizes plus the live `ctx.getContextUsage()` reading.

**Note:** `getAllTools()` is on `ExtensionAPI` (`pi` in the factory), not on `ExtensionContext` (`ctx` in `execute()`). The factory passes it into the tool via closure.

## Usage

```bash
# One-shot diagnostic (no TUI)
bun bun-apps/pi-agent/src/cli.ts \
  -e bun-apps/pi-agent-ext-power-tool/src/index.ts \
  -p "call context_analyzer"

# With another extension to see its contribution
bun bun-apps/pi-agent/src/cli.ts \
  -e bun-apps/pi-agent-ext-power-tool/src/index.ts \
  -e bun-apps/some-other-ext/src/index.ts \
  -p "call context_analyzer"

# Interactive TUI session
bun bun-apps/pi-agent/src/cli.ts \
  -e bun-apps/pi-agent-ext-power-tool/src/index.ts
# then type: call context_analyzer
```

## Layout

```
pi-agent-ext-power-tool/
├── package.json       # @repo/pi-agent-ext-power-tool
└── src/
    └── index.ts       # ExtensionFactory — event hook + tool registration
```

## What the numbers mean

A fresh default pi session in this repo uses **~19,924 tokens (~9.7% of 205k)** before any conversation.
The system prompt alone is **~9,242 tokens** (34,194 chars):

```
CLAUDE.md         16,984 chars   ~4,590 tok   (50% of system prompt)
Guidelines        12,058 chars   ~3,259 tok   (all tool promptGuidelines bullets)
Skills              1,613 chars     ~436 tok
+ base pi prompt + tool snippets + tool schemas in API call
─────────────────────────────────────────────────────────
Total context:    ~19,924 tok    (~9.7% of 205k)
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
