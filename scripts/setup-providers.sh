#!/usr/bin/env bash
########################################
# setup-providers.sh — One-command multi-provider Claude Code setup
#
# Automates the "Reproduce on a New Machine" workflow from
# scripts/claude-origin.README.md:
#   1. Detect existing config dirs
#   2. Validate env vars
#   3. Deploy MCP servers (settings.json + .claude.json)
#   4. Deploy statusline scripts
#   5. Print summary
#
# USAGE:
#   ./scripts/setup-providers.sh
#   ./scripts/setup-providers.sh --dry-run
########################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      echo "Usage: $0 [--dry-run]"
      echo "Set up all Claude Code provider config dirs."
      exit 0
      ;;
  esac
done

# --- Config ---

CONFIG_DIRS=(
  "$HOME/.claude"
  "$HOME/.claude-glm"
  "$HOME/.claude-deepseek"
)

ENV_VARS=(
  "ANTHROPIC_API_KEY"
  "ZAI_API_KEY"
  "DEEPSEEK_API_KEY"
)

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

STATUSLINE_SOURCE="$SCRIPT_DIR/statusline-command.sh"

# --- Tracking ---

PASS=0
FAIL=0
WARN=0
RESULTS=()

record() {
  local status="$1" label="$2" msg="$3"
  RESULTS+=("$status|$label|$msg")
  case "$status" in
    PASS) PASS=$((PASS + 1)) ;;
    FAIL) FAIL=$((FAIL + 1)) ;;
    WARN) WARN=$((WARN + 1)) ;;
  esac
}

# --- Step 1: Env vars ---

echo "=== Step 1: Environment Variables ==="
for var in "${ENV_VARS[@]}"; do
  if [ -n "${!var:-}" ]; then
    record PASS "$var" "set"
    echo "  [PASS] $var is set"
  else
    record WARN "$var" "not set"
    echo "  [WARN] $var is not set — some features may not work"
  fi
done
echo ""

# --- Step 2: Config dirs ---

echo "=== Step 2: Config Directories ==="
FOUND_DIRS=()
for dir in "${CONFIG_DIRS[@]}"; do
  if [ -d "$dir" ]; then
    FOUND_DIRS+=("$dir")
    record PASS "$dir" "exists"
    echo "  [PASS] $dir"
  else
    record WARN "$dir" "not found"
    echo "  [WARN] $dir not found — create it or run claude once first"
  fi
done
echo ""

# --- Step 3: Deploy MCP ---

echo "=== Step 3: MCP Servers ==="
for dir in "${FOUND_DIRS[@]}"; do
  for file in "settings.json" ".claude.json"; do
    filepath="$dir/$file"
    if [ ! -f "$filepath" ]; then
      if [ "$DRY_RUN" -eq 1 ]; then
        echo "  [SKIP] $dir/$file — not found"
        continue
      fi
      # Create with minimal structure
      echo "{}" > "$filepath"
    fi

    # Check if already in sync
    in_sync=$(python3 -c "
import json
try:
    with open('$filepath') as f:
        data = json.load(f)
    existing = json.dumps(data.get('mcpServers', {}), sort_keys=True)
    canonical = json.dumps(json.loads('''$CANONICAL_MCP'''), sort_keys=True)
    print('yes' if existing == canonical else 'no')
except Exception:
    print('no')
" 2>/dev/null || echo "no")

    if [ "$in_sync" = "yes" ]; then
      record PASS "$dir/$file" "MCP in sync"
      echo "  [PASS] $dir/$file — MCP already configured"
    else
      if [ "$DRY_RUN" -eq 1 ]; then
        record WARN "$dir/$file" "would update MCP"
        echo "  [WOULD UPDATE] $dir/$file"
      else
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
" 2>/dev/null
        record PASS "$dir/$file" "MCP deployed"
        echo "  [SYNCED] $dir/$file — MCP deployed"
      fi
    fi
  done
done
echo ""

# --- Step 4: Deploy statusline ---

echo "=== Step 4: Statusline Scripts ==="
if [ -f "$STATUSLINE_SOURCE" ]; then
  for dir in "${FOUND_DIRS[@]}"; do
    target="$dir/statusline-command.sh"
    if [ "$DRY_RUN" -eq 1 ]; then
      if [ -f "$target" ]; then
        record PASS "$target" "exists"
        echo "  [PASS] $target — already installed"
      else
        record WARN "$target" "would install"
        echo "  [WOULD INSTALL] $target"
      fi
    else
      cp "$STATUSLINE_SOURCE" "$target"
      chmod +x "$target"
      record PASS "$target" "installed"
      echo "  [INSTALLED] $target"
    fi
  done
else
  record FAIL "statusline" "source not found: $STATUSLINE_SOURCE"
  echo "  [FAIL] Source not found: $STATUSLINE_SOURCE"
fi
echo ""

# --- Summary ---

echo "=== Summary ==="
echo "PASS: $PASS  |  WARN: $WARN  |  FAIL: $FAIL"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "Some steps failed. Check output above."
  exit 1
elif [ "$WARN" -gt 0 ]; then
  echo "Setup completed with warnings. Set missing env vars and re-run."
  exit 0
else
  echo "All steps completed successfully."
  exit 0
fi
