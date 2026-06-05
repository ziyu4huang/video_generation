# Claude Code — Multi-Provider Setup & Reproducibility

Single reference for configuring all three LLM providers with Claude Code CLI:
**Claude (origin)**, **GLM (Z.AI)**, **DeepSeek**.

---

## Provider Overview

| Provider | Launch Script | `CLAUDE_CONFIG_DIR` | API Key Env Var |
|----------|---------------|---------------------|-----------------|
| Claude (origin) | `claude-code-origin.sh` | `~/.claude` | `ANTHROPIC_API_KEY` |
| GLM (Z.AI) | `claude-code-glm.sh` | `~/.claude-glm` | `ZAI_API_KEY` |
| DeepSeek | `claude-code-deepseek.sh` | `~/.claude-deepseek` | `DEEPSEEK_API_KEY` |

---

## Provider Environment Variables

### Claude (origin)

`claude-code-origin.sh` strips all GLM/Z.AI overrides and resets `CLAUDE_CONFIG_DIR` to `~/.claude`.
No special env vars needed beyond `ANTHROPIC_API_KEY`.

### GLM (Z.AI) — `claude-code-glm.sh`

```sh
export ZAI_API_KEY="<your-z-ai-api-key>"

# Overrideable defaults (set before sourcing claude-code-glm.sh)
Z_AI_MODE="ZAI"
Z_AI_MODEL_OPUS="glm-5.1"
Z_AI_MODEL_DEFAULT="glm-5.1"
Z_AI_MODEL_AIR="glm-4.5-air"
```

Internally sets:
- `ANTHROPIC_AUTH_TOKEN=$ZAI_API_KEY`
- `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic`
- `CLAUDE_CONFIG_DIR=~/.claude-glm`

Docs: https://docs.z.ai/devpack/tool/claude

### DeepSeek — `claude-code-deepseek.sh`

```sh
export DEEPSEEK_API_KEY="<your-deepseek-api-key>"

# Overrideable defaults
DEEPSEEK_MODEL_DEFAULT="deepseek-v4-pro[1m]"
DEEPSEEK_MODEL_REASONER="deepseek-v4-pro[1m]"
DEEPSEEK_MODEL_AIR="deepseek-v4-flash"
```

Internally sets:
- `ANTHROPIC_AUTH_TOKEN=$DEEPSEEK_API_KEY`
- `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`
- `CLAUDE_CONFIG_DIR=~/.claude-deepseek`

Docs: https://api-docs.deepseek.com/guides/anthropic_api

---

## Z.AI MCP Servers

Four Z.AI MCP servers are configured globally. They authenticate via `ZAI_API_KEY` — **no hardcoded token in any file**.

### MCP config block

```json
"mcpServers": {
  "web-search-prime": {
    "type": "http",
    "url": "https://api.z.ai/api/mcp/web_search_prime/mcp",
    "headers": { "Authorization": "Bearer ${ZAI_API_KEY}" }
  },
  "web-reader": {
    "type": "http",
    "url": "https://api.z.ai/api/mcp/web_reader/mcp",
    "headers": { "Authorization": "Bearer ${ZAI_API_KEY}" }
  },
  "zread": {
    "type": "http",
    "url": "https://api.z.ai/api/mcp/zread/mcp",
    "headers": { "Authorization": "Bearer ${ZAI_API_KEY}" }
  },
  "zai-mcp-server": {
    "type": "stdio",
    "command": "bunx",
    "args": ["-y", "@z_ai/mcp-server"],
    "env": {
      "ZAI_API_KEY": "${ZAI_API_KEY}",
      "Z_AI_MODE": "ZAI"
    }
  }
}
```

> Claude Code uses `${ZAI_API_KEY}` interpolation. OpenCode uses `{env:ZAI_API_KEY}` — see `.opencode/opencode.json.md`.

### Critical: MCP must be in BOTH settings.json AND .claude.json

Claude Code reads MCP config from **two** locations within each `CLAUDE_CONFIG_DIR`:

1. `settings.json` — user-editable settings
2. `.claude.json` — Claude Code internal state (also read for MCP at startup)

**Both files must contain the `mcpServers` block.** If `.claude.json` has an empty `{}` for MCP, Claude Code will show "No MCP servers configured" even if `settings.json` is correct. Claude Code may overwrite `.claude.json` during updates, clearing `mcpServers` — re-merge after updates.

### Project-level MCP: replaces, not merges

Project-level `.claude/settings.json` with `mcpServers` **replaces** (does not merge with) the global config dir's `mcpServers`. If the project file only has `drawthings`, all Z.AI servers are hidden. Merge all needed servers into the project file.

### Config targets

| File | Purpose | Must have mcpServers? |
|------|---------|-----------------------|
| `~/.claude.json` | Global Claude config | Yes |
| `~/.claude/settings.json` | Claude origin config dir | Yes |
| `~/.claude/.claude.json` | Claude origin internal state | Yes |
| `~/.claude-glm/settings.json` | GLM override config dir | Yes |
| `~/.claude-glm/.claude.json` | GLM internal state | Yes |
| `~/.claude-deepseek/settings.json` | DeepSeek override config dir | Yes |
| `~/.claude-deepseek/.claude.json` | DeepSeek internal state | Yes |
| `.claude/settings.json` | Project-level config | Yes (merge all servers) |

### MCP server tool reference

| Server | Tools |
|--------|-------|
| `web-search-prime` | `web_search_prime` |
| `web-reader` | `webReader` |
| `zread` | `get_repo_structure`, `read_file`, `search_doc` |
| `zai-mcp-server` | `analyze_image`, `analyze_video`, `ui_diff_check`, `ui_to_artifact`, `understand_technical_diagram`, `extract_text_from_screenshot`, `diagnose_error_screenshot`, `analyze_data_visualization` |

---

## Status Line

Each config dir needs its own copy of the statusline script plus a `statusLine` entry in `settings.json`.

**Source scripts:** `scripts/statusline-command.sh` (macOS/Linux) and `scripts/statusline-command.ps1` (Windows).

### Install statusline scripts (macOS / Linux)

```bash
SOURCE="$(git rev-parse --show-toplevel)/scripts/statusline-command.sh"
for dir in ~/.claude ~/.claude-glm ~/.claude-deepseek; do
  [ -d "$dir" ] || continue
  cp "$SOURCE" "$dir/statusline-command.sh"
  chmod +x "$dir/statusline-command.sh"
  echo "Installed → $dir"
done
```

### `settings.json` — `statusLine` entry per config dir

```json
// ~/.claude/settings.json
{ "statusLine": { "type": "command", "command": "bash ~/.claude/statusline-command.sh" } }

// ~/.claude-glm/settings.json
{ "statusLine": { "type": "command", "command": "bash ~/.claude-glm/statusline-command.sh" } }

// ~/.claude-deepseek/settings.json
{ "statusLine": { "type": "command", "command": "bash ~/.claude-deepseek/statusline-command.sh" } }
```

### Input JSON fields

| Field | Type | Description |
|-------|------|-------------|
| `.model.display_name` | string | e.g. `"Claude Sonnet 4.6"`, `"glm-5.1"` |
| `.workspace.current_dir` | string | Absolute CWD path |
| `.context_window.used_percentage` | float | e.g. `5.2` |
| `.context_window.total_input_tokens` | int | Accumulated input tokens |
| `.context_window.total_output_tokens` | int | Accumulated output tokens |

---

## Reproduce on a New Machine

### 1. Shell profile (`~/.zshrc` or `~/.bashrc`)

```sh
export ANTHROPIC_API_KEY="<claude-api-key>"
export ZAI_API_KEY="<z-ai-api-key>"
export DEEPSEEK_API_KEY="<deepseek-api-key>"

source /path/to/scripts/claude-code-glm.sh
source /path/to/scripts/claude-code-deepseek.sh
```

### 2. MCP servers

Merge the `mcpServers` block (see above) into:
- `~/.claude.json`
- `~/.claude/settings.json`
- `~/.claude-glm/settings.json`
- `~/.claude-deepseek/settings.json`

### 3. Statusline scripts

```bash
SOURCE="$(git rev-parse --show-toplevel)/scripts/statusline-command.sh"
for dir in ~/.claude ~/.claude-glm ~/.claude-deepseek; do
  [ -d "$dir" ] || continue
  cp "$SOURCE" "$dir/statusline-command.sh"
  chmod +x "$dir/statusline-command.sh"
done
```

Add the `statusLine` entry to each dir's `settings.json` (see above).

### 4. Restart Claude Code

Claude Code reads `CLAUDE_CONFIG_DIR` and interpolates `${ZAI_API_KEY}` at startup.

---

## Adding a New Provider Variant

When adding a new `CLAUDE_CONFIG_DIR` (e.g. `~/.claude-newprovider`):

1. Create a launch script (copy `claude-code-glm.sh` or `claude-code-deepseek.sh` as template)
2. Copy `scripts/statusline-command.sh` → `~/.claude-newprovider/statusline-command.sh` and `chmod +x`
3. Create `~/.claude-newprovider/settings.json` with:
   - `statusLine` pointing to the new dir's script
   - `mcpServers` block (same as above)
4. Add the launch function to your shell profile

---

## Notes

- `claude-code-origin.sh` does **not** unset `ZAI_API_KEY` — the MCP servers are part of stock Claude, not the GLM layer.
- The reference scripts live in `scripts/` and are checked into git. The live copies are in each `~/.claude*/` dir. Run the install snippet above to sync after editing.
- Troubleshooting statusline: ensure `jq` is installed; each config dir must reference its own script copy.
