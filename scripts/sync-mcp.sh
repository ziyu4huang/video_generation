#!/usr/bin/env bash
########################################
# sync-mcp.sh — Keep MCP config consistent across all config dirs
#
# Reads canonical MCP server definitions and merges them into both
# settings.json and .claude.json in every Claude Code config dir.
#
# USAGE:
#   ./scripts/sync-mcp.sh              # sync all dirs
#   ./scripts/sync-mcp.sh --verify     # check for drift, exit 1 if found
#   ./scripts/sync-mcp.sh --dry-run    # show what would change
#
# WHY: Claude Code reads MCP from BOTH settings.json AND .claude.json
# inside CLAUDE_CONFIG_DIR. Updates can wipe .claude.json, breaking MCP.
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

# Canonical MCP server definitions as JSON
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

CONFIG_DIRS=(
  "$HOME/.claude"
  "$HOME/.claude-glm"
  "$HOME/.claude-deepseek"
)

merge_mcp_into_file() {
  local filepath="$1"
  local label="$2"

  if [ ! -f "$filepath" ]; then
    echo "  [SKIP] $label — file not found: $filepath"
    return
  fi

  # Check if mcpServers already matches canonical
  local current
  current=$(python3 -c "
import json, sys
try:
    with open('$filepath') as f:
        data = json.load(f)
    existing = json.dumps(data.get('mcpServers', {}), sort_keys=True)
    canonical = json.dumps(json.loads('''$CANONICAL_MCP'''), sort_keys=True)
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
    echo "  [WOULD UPDATE] $label — would merge mcpServers"
    return 0
  fi

  # Merge canonical mcpServers into file, preserving all other keys
  python3 -c "
import json
filepath = '$filepath'
canonical = json.loads('''$CANONICAL_MCP''')
with open(filepath) as f:
    data = json.load(f)
data['mcpServers'] = canonical
with open(filepath, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
print('  [SYNCED] $label — mcpServers updated')
"
}

echo "=== MCP Sync ==="
echo "Canonical servers: $(echo "$CANONICAL_MCP" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))") servers"
echo ""

DRIFT_FOUND=0

for dir in "${CONFIG_DIRS[@]}"; do
  if [ ! -d "$dir" ]; then
    echo "[SKIP] $dir — directory not found"
    continue
  fi

  echo "$dir"
  merge_mcp_into_file "$dir/settings.json" "settings.json" || DRIFT_FOUND=1
  merge_mcp_into_file "$dir/.claude.json" ".claude.json" || DRIFT_FOUND=1
  echo ""
done

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
