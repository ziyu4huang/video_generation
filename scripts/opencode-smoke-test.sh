#!/usr/bin/env bash
########################################
# opencode-smoke-test.sh — E2E smoke tests for opencode config
#
# Tests provider connectivity, MCP servers, and agent loading.
# Must be run from project root (where .opencode/ lives).
#
# USAGE:
#   ./scripts/opencode-smoke-test.sh                # run all checks
#   ./scripts/opencode-smoke-test.sh --provider my-zai   # provider checks only
#   ./scripts/opencode-smoke-test.sh --mcp               # MCP checks only
#   ./scripts/opencode-smoke-test.sh --agent build-my-zai # specific agent only
#   ./scripts/opencode-smoke-test.sh --verbose           # debug output
#   ./scripts/opencode-smoke-test.sh --help
########################################
set -euo pipefail

# --- Defaults ---
VERBOSE=0
RUN_PROVIDER=""
RUN_MCP=0
RUN_AGENT=""
RUN_ALL=1

for arg in "$@"; do
  case "$arg" in
    --provider) shift; RUN_PROVIDER="${1:-}"; RUN_ALL=0; shift ;;
    --mcp) RUN_MCP=1; RUN_ALL=0 ;;
    --agent) shift; RUN_AGENT="${1:-}"; RUN_ALL=0; shift ;;
    --verbose) VERBOSE=1 ;;
    --help|-h)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --provider <name>  Run only provider checks for named provider (my-zai, my-ds)"
      echo "  --mcp              Run only MCP server checks"
      echo "  --agent <name>     Run only the named agent check"
      echo "  --verbose          Include debug output from opencode"
      echo "  --help             Show this help"
      echo ""
      echo "Examples:"
      echo "  $0                           # all checks"
      echo "  $0 --provider my-zai         # only my-zai provider"
      echo "  $0 --mcp                     # only MCP checks"
      echo "  $0 --agent build-my-zai      # only build-my-zai agent"
      exit 0
      ;;
  esac
done

# --- Tracking ---
PASS=0
FAIL=0
SKIP=0
TOTAL=0

pass() { PASS=$((PASS + 1)); TOTAL=$((TOTAL + 1)); echo "  [PASS] $1"; }
fail() { FAIL=$((FAIL + 1)); TOTAL=$((TOTAL + 1)); echo "  [FAIL] $1 $2"; }
skip() { SKIP=$((SKIP + 1)); TOTAL=$((TOTAL + 1)); echo "  [SKIP] $1 $2"; }

# --- Prerequisites ---

if [ "$VERBOSE" -eq 1 ]; then
  OPENCODE_FLAGS="--log-level DEBUG --print-logs"
else
  OPENCODE_FLAGS=""
fi

# jq check (needed for provider/MCP checks)
if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required. Install with: brew install jq"
  exit 1
fi

# opencode check
if ! command -v opencode &>/dev/null; then
  echo "ERROR: opencode not found in PATH. Install with: bun install -g opencode"
  exit 1
fi

# .opencode directory check
if [ ! -d ".opencode" ] || [ ! -f ".opencode/opencode.json" ]; then
  echo "ERROR: Run from project root (where .opencode/opencode.json lives)"
  exit 1
fi

# =============================================
# SLICE 1: Env var sanity
# =============================================

run_env_checks() {
  echo "=== Environment Variables ==="

  for var in ZAI_API_KEY DEEPSEEK_API_KEY; do
    val="${!var:-}"
    if [ -z "$val" ]; then
      fail "$var" "— not set"
    elif [ "$val" = "{env:$var}" ]; then
      fail "$var" "— literal template string (not expanded)"
    else
      pass "$var is set"
    fi
  done
  echo ""
}

# =============================================
# SLICE 2: Provider round-trip checks
# =============================================

run_provider_check() {
  local provider="$1"
  local model="$2"

  echo "=== Provider: $provider ($model) ==="

  result=$(opencode run --format json $OPENCODE_FLAGS --model "$model" \
    "Reply with exactly: OPENCODE_SMOKE_OK" 2>/dev/null || true)

  answer=$(echo "$result" | jq -r 'select(.type=="text") | .part.text' 2>/dev/null | head -1)

  if echo "$answer" | grep -q "OPENCODE_SMOKE_OK"; then
    pass "provider:$provider ($model) round-trip OK"
  else
    if [ -z "$result" ]; then
      fail "provider:$provider ($model)" "— no response (check API key or network)"
    else
      fail "provider:$provider ($model)" "— unexpected response: $(echo "$answer" | head -c 100)"
    fi
  fi
  echo ""
}

run_provider_checks() {
  if [ -n "$RUN_PROVIDER" ]; then
    case "$RUN_PROVIDER" in
      my-zai) run_provider_check "my-zai" "my-zai/glm-5.1" ;;
      my-ds) run_provider_check "my-ds" "my-ds/deepseek-v4-pro" ;;
      *) echo "Unknown provider: $RUN_PROVIDER (expected: my-zai, my-ds)"; FAIL=$((FAIL + 1)) ;;
    esac
  else
    run_provider_check "my-zai" "my-zai/glm-5.1"
    run_provider_check "my-ds" "my-ds/deepseek-v4-pro"
  fi
}

# =============================================
# SLICE 3: Remote MCP checks
# =============================================

run_mcp_remote_checks() {
  echo "=== Remote MCP Servers ==="

  local zai_key="${ZAI_API_KEY:-}"
  if [ -z "$zai_key" ]; then
    skip "remote MCP" "— ZAI_API_KEY not set"
    echo ""
    return
  fi

  for server in "web_search_prime" "web_reader" "zread"; do
    url="https://api.z.ai/api/mcp/${server}/mcp"

    status=$(curl -s -o /dev/null -w "%{http_code}" \
      --max-time 30 \
      -H "Authorization: Bearer $zai_key" \
      "$url" 2>/dev/null || echo "000")

    if [ "$status" = "000" ]; then
      fail "mcp:$server" "— unreachable (timeout or network)"
    elif [ "$status" = "401" ] || [ "$status" = "403" ]; then
      fail "mcp:$server" "— auth error (HTTP $status, check ZAI_API_KEY)"
    else
      pass "mcp:$server reachable (HTTP $status)"
    fi
  done
  echo ""
}

# =============================================
# SLICE 4: Local stdio MCP check
# =============================================

run_mcp_local_checks() {
  echo "=== Local MCP Servers ==="

  if ! command -v bunx &>/dev/null; then
    skip "mcp:zai-mcp-server" "— bunx not found (install bun)"
    echo ""
    return
  fi

  # macOS lacks GNU timeout; use background + wait with kill
  bunx -y @z_ai/mcp-server --help &>/dev/null &
  local pid=$!
  local elapsed=0
  while kill -0 "$pid" 2>/dev/null && [ $elapsed -lt 60 ]; do
    sleep 2
    elapsed=$((elapsed + 2))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    fail "mcp:zai-mcp-server" "— timed out after 60s"
  else
    wait "$pid"
    local ec=$?
    if [ $ec -eq 0 ]; then
      pass "mcp:zai-mcp-server starts via bunx"
    else
      fail "mcp:zai-mcp-server" "— bunx execution failed (exit $ec)"
    fi
  fi
  echo ""
}

# =============================================
# SLICE 5: Agent smoke checks
# =============================================

run_agent_check() {
  local agent="$1"

  echo "=== Agent: $agent ==="

  # Check agent file exists (for file-based agents)
  agent_file=".opencode/agents/${agent}.md"
  if [ ! -f "$agent_file" ]; then
    # May be a built-in agent without a file
    :
  fi

  result=$(opencode run --format json $OPENCODE_FLAGS --agent "$agent" \
    "Reply with exactly: OPENCODE_SMOKE_OK" 2>/dev/null || true)

  answer=$(echo "$result" | jq -r 'select(.type=="text") | .part.text' 2>/dev/null | head -1)

  if [ -n "$answer" ]; then
    pass "agent:$agent responds"
  else
    if [ -z "$result" ]; then
      fail "agent:$agent" "— no response (agent may not be configured)"
    else
      fail "agent:$agent" "— empty response"
    fi
  fi
  echo ""
}

run_agent_checks() {
  if [ -n "$RUN_AGENT" ]; then
    run_agent_check "$RUN_AGENT"
  else
    run_agent_check "build-my-zai"
    run_agent_check "explore-my-zai"
    run_agent_check "office-ops"
    run_agent_check "gcc-coordinator"
  fi
}

# =============================================
# Main
# =============================================

if [ "$RUN_ALL" -eq 1 ]; then
  run_env_checks
  run_provider_checks
  run_mcp_remote_checks
  run_mcp_local_checks
  run_agent_checks
else
  [ -n "$RUN_PROVIDER" ] && run_provider_checks
  [ "$RUN_MCP" -eq 1 ] && { run_mcp_remote_checks; run_mcp_local_checks; }
  [ -n "$RUN_AGENT" ] && run_agent_checks
fi

# --- Summary ---
echo "=== Summary ==="
echo "$PASS/$TOTAL checks passed"
[ "$SKIP" -gt 0 ] && echo "$SKIP skipped"
echo ""

if [ "$FAIL" -gt 0 ]; then
  [ "$VERBOSE" -eq 0 ] && echo "Tip: re-run with --verbose for full debug output"
  exit 1
else
  echo "All checks passed."
  exit 0
fi
