# pi-agent-ext-power-tool

A **pi extension** that adds developer-focused diagnostic tools.

## Tools

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

A fresh default pi session in this repo uses **~19,924 tokens (15.6% of 128k)** before any conversation.
The system prompt alone is **~9,242 tokens** (34,194 chars):

```
CLAUDE.md         16,984 chars   ~4,590 tok   (50% of system prompt)
Guidelines        12,058 chars   ~3,259 tok   (all tool promptGuidelines bullets)
Skills              1,613 chars     ~436 tok
+ base pi prompt + tool snippets + tool schemas in API call
─────────────────────────────────────────────────────────
Total context:    ~19,924 tok    (15.6% of 128k)
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
