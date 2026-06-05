# Scripts

Utility scripts for the dev_game project. Provider launch scripts are documented in [claude-origin.README.md](claude-origin.README.md).

## Provider Setup

| Script | Purpose |
|--------|---------|
| `setup-providers.sh` | One-command setup for all config dirs (MCP, statusline) |
| `sync-mcp.sh` | Keep MCP config consistent across all config dirs |
| `claude-code-origin.sh` / `.ps1` | Launch original Claude CLI (clean Anthropic env) |
| `claude-code-glm.sh` / `.ps1` | Launch Claude Code via GLM/Z.AI API |
| `claude-code-deepseek.sh` / `.ps1` | Launch Claude Code via DeepSeek API |
| `claude-code-custom.sh` / `.ps1` | Launch Claude Code with isolated ~/.claude-custom profile |

See [claude-origin.README.md](claude-origin.README.md) for full provider setup guide.

## Skill Quality

### verify-skills.ts

Quality gate for agent skills — validates description length (≤ 150 chars), trigger keywords, tags, line counts, and symlink integrity.

```bash
bun scripts/verify-skills.ts                           # static checks (fast)
bun scripts/verify-skills.ts --live                    # + live smoke test via claude-code-glm.sh
bun scripts/verify-skills.ts --live --backend deepseek # use claude-code-deepseek.sh
bun scripts/verify-skills.ts --skill <name>            # single skill
```

### install-skill-hooks.sh

Installs a git pre-commit hook that runs `verify-skills.ts` on staged SKILL.md files.

```bash
./scripts/install-skill-hooks.sh
```

## Testing

### run-smart-test.sh

Intelligent test runner that detects code changes via `git diff` and runs only affected test categories.

```bash
./scripts/run-smart-test.sh              # auto-detect changed files → run affected tests
./scripts/run-smart-test.sh --all        # run all test categories
./scripts/run-smart-test.sh --unit       # unit tests only
./scripts/run-smart-test.sh --e2e        # E2E tests only
./scripts/run-smart-test.sh --agent      # agent→skill→CLI tests
./scripts/run-smart-test.sh --skill novel  # test specific skill
./scripts/run-smart-test.sh --base HEAD~3  # diff against specific ref
```

Dependencies: `cargo`, `gh` CLI, `ZAI_API_KEY` (for agent tests).

## Project Management

### sync-todo.sh

Syncs TODO.md with GitHub issues. Pulls issues with `needs-triage`, `ready-for-agent`, and backlog labels.

```bash
./scripts/sync-todo.sh
```

### memory-acp.js

Memory management via ACP WebSocket protocol. Sends natural-language instructions to agents for memory operations.

```bash
./scripts/memory-acp.js --action read              # read today's memory
./scripts/memory-acp.js --action write --message "..."  # write entry
./scripts/memory-acp.js --action list               # list memory files
./scripts/memory-acp.js --action search --slug "..."     # search memories
./scripts/memory-acp.js --action read --long-term   # read MEMORY.md
```

Dependencies: Node.js, WebSocket library, OpenClaw gateway on `localhost:18789`.

## Infrastructure

### run_surreal.sh

SurrealDB server launcher with auto-download. See [run_surreal.README.md](run_surreal.README.md) for full configuration options.

```bash
./scripts/run_surreal.sh              # start with defaults (memory backend)
./scripts/run_surreal.sh --persist    # persistent storage
```

### opencode-smoke-test.sh

E2E smoke tests for opencode config — env vars, provider round-trips, MCP servers, agent loading.

```bash
./scripts/opencode-smoke-test.sh                # all checks
./scripts/opencode-smoke-test.sh --provider my-zai  # provider only
./scripts/opencode-smoke-test.sh --mcp           # MCP checks only
./scripts/opencode-smoke-test.sh --agent build-my-zai  # single agent
./scripts/opencode-smoke-test.sh --verbose       # debug output
```

Dependencies: `opencode`, `jq`, `curl`, `bunx` (for local MCP check).
```

### setup_venv.sh

Creates a shared Python virtual environment at `~/proj/unified_venv` for all compatible Python apps, with symlinks from each app's `.venv`.

```bash
./scripts/setup_venv.sh              # create + install + symlink
./scripts/setup_venv.sh --check      # verify current setup
./scripts/setup_venv.sh --no-install # create venv only, skip pip install
```

ComfyUI keeps its own isolated `.venv` (torch+custom nodes). See `scripts/requirements-unified.txt` for the merged dependency list.

### statusline-command.sh / .ps1

Custom statusline for Claude Code. Shows model name, workspace folder, context %, and token count. See [claude-origin.README.md](claude-origin.README.md) for installation.
