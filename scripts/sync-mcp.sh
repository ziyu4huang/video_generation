#!/usr/bin/env bash
########################################
# sync-mcp.sh — Keep MCP config consistent across all config dirs
#
# Reads canonical MCP server definitions and merges them into:
#   - settings.json and .claude.json in every Claude Code config dir
#   - opencode.json (global OpenCode config)
#
# USAGE:
#   ./scripts/sync-mcp.sh              # sync all dirs
#   ./scripts/sync-mcp.sh --verify     # check for drift, exit 1 if found
#   ./scripts/sync-mcp.sh --dry-run    # show what would change
#
# WHY: Claude Code reads MCP from BOTH settings.json AND .claude.json
# inside CLAUDE_CONFIG_DIR. Updates can wipe .claude.json, breaking MCP.
# OpenCode uses ~/.config/opencode/opencode.json with {env:VAR} syntax.
# See .agents/memory/feedback/mcp-config-rca.md
########################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=0
VERIFY=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --verify)  VERIFY=1 ;;
    --help|-h)
      echo "Usage: $0 [--dry-run] [--verify]"
      echo "  --dry-run  Show what would change without writing"
      echo "  --verify   Check all dirs are in sync (exit 1 if drift)"
      exit 0
      ;;
  esac
done

# Canonical MCP server definitions — Claude Code format (${VAR}, type: http/stdio)
CANONICAL_MCP='{
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
}'

# Canonical MCP server definitions — OpenCode format ({env:VAR}, type: local/remote)
CANONICAL_OPENCODE_MCP='{
  "web-search-prime": {
    "type": "remote",
    "url": "https://api.z.ai/api/mcp/web_search_prime/mcp",
    "headers": { "Authorization": "Bearer {env:ZAI_API_KEY}" }
  },
  "web-reader": {
    "type": "remote",
    "url": "https://api.z.ai/api/mcp/web_reader/mcp",
    "headers": { "Authorization": "Bearer {env:ZAI_API_KEY}" }
  },
  "zread": {
    "type": "remote",
    "url": "https://api.z.ai/api/mcp/zread/mcp",
    "headers": { "Authorization": "Bearer {env:ZAI_API_KEY}" }
  },
  "zai-mcp-server": {
    "type": "local",
    "command": ["bunx", "-y", "@z_ai/mcp-server"],
    "environment": {
      "ZAI_API_KEY": "{env:ZAI_API_KEY}",
      "Z_AI_MODE": "ZAI"
    }
  }
}'

CLAUDE_CONFIG_DIRS=(
  "$HOME/.claude"
  "$HOME/.claude-glm"
  "$HOME/.claude-deepseek"
)

OPENCODE_CONFIG="$HOME/.config/opencode/opencode.json"

merge_mcp_into_file() {
  local filepath="$1"
  local label="$2"
  local key="${3:-mcpServers}"
  local canonical="$4"

  if [ ! -f "$filepath" ]; then
    echo "  [SKIP] $label — file not found: $filepath"
    return
  fi

  local current
  current=$(python3 -c "
import json, sys
try:
    with open('$filepath') as f:
        data = json.load(f)
    existing = json.dumps(data.get('$key', {}), sort_keys=True)
    canonical = json.dumps(json.loads('''$canonical'''), sort_keys=True)
    if existing == canonical:
        sys.exit(0)  # in sync
    else:
        sys.exit(1)  # drift
except Exception:
    sys.exit(2)  # error
")

  if [ $? -eq 0 ]; then
    echo "  [OK]   $label — already in sync"
    return 0
  fi

  if [ "$VERIFY" -eq 1 ]; then
    echo "  [DRIFT] $label — MCP servers differ from canonical"
    return 1
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  [WOULD UPDATE] $label — would merge $key"
    return 0
  fi

  # Merge canonical MCP into file, preserving all other keys
  python3 -c "
import json
filepath = '$filepath'
key = '$key'
canonical = json.loads('''$canonical''')
with open(filepath) as f:
    data = json.load(f)
data[key] = canonical
with open(filepath, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
print('  [SYNCED] $label — $key updated')
"
}

echo "=== MCP Sync ==="
echo "Claude Code target: $(echo "$CANONICAL_MCP" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))") servers"
echo "OpenCode target:   $(echo "$CANONICAL_OPENCODE_MCP" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))") servers"
echo ""

DRIFT_FOUND=0

# --- Claude Code config dirs ---
for dir in "${CLAUDE_CONFIG_DIRS[@]}"; do
  if [ ! -d "$dir" ]; then
    echo "[SKIP] $dir — directory not found"
    continue
  fi

  echo "$dir"
  merge_mcp_into_file "$dir/settings.json" "settings.json" "mcpServers" "$CANONICAL_MCP" || DRIFT_FOUND=1
  merge_mcp_into_file "$dir/.claude.json" ".claude.json" "mcpServers" "$CANONICAL_MCP" || DRIFT_FOUND=1
  echo ""
done

# --- OpenCode global config ---
echo "OpenCode (global)"
merge_mcp_into_file "$OPENCODE_CONFIG" "opencode.json" "mcp" "$CANONICAL_OPENCODE_MCP" || DRIFT_FOUND=1
echo ""

if [ "$VERIFY" -eq 1 ]; then
  if [ "$DRIFT_FOUND" -eq 0 ]; then
    echo "All config dirs in sync."
    exit 0
  else
    echo "Drift detected. Run without --verify to sync."
    exit 1
  fi
fi

echo "Done."
