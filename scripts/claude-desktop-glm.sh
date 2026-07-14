#!/usr/bin/env bash
# claude-desktop-glm.sh — configure Claude Desktop to use GLM (z.ai) as inference backend.
#
# Edits ~/Library/Application Support/Claude-3p/configLibrary/{_meta,<uuid>}.json
# and restarts Claude Desktop. macOS only.
#
# Usage:
#   ./scripts/claude-desktop-glm.sh          # configure to GLM and restart
#   ./scripts/claude-desktop-glm.sh reset    # remove GLM entry (revert to Anthropic)
#   ./scripts/claude-desktop-glm.sh status   # show current applied config
#   ./scripts/claude-desktop-glm.sh -h       # help
#
# Prerequisites:
#   - Claude Desktop installed at /Applications/Claude.app
#   - Developer Mode enabled: Help → Troubleshooting → Enable Developer Mode
#   - jq available at /usr/bin/jq (bundled on macOS Sonoma+)
#   - ZAI_API_KEY set in env, or exported in ~/.zshrc / ~/.bashrc
#
# Note: Chat mode is unavailable while a third-party gateway is active
# (Chat depends on Anthropic-hosted features). Only Cowork (3P) and Code
# modes work. To restore Chat: at launch chooser pick "Continue with
# Anthropic", or toggle "Skip login-mode chooser" off in
# Developer → Configure Third-Party Inference.

set -euo pipefail

CONFIG_DIR="$HOME/Library/Application Support/Claude-3p/configLibrary"
META="$CONFIG_DIR/_meta.json"
ENTRY_NAME="claude-desktop-glm"
BASE_URL="https://api.z.ai/api/anthropic"
AUTH_SCHEME="bearer"
# z.ai does server-side mapping: send standard claude names → GLM runs on backend.
# Sending glm-* names directly breaks because Claude Desktop's built-in validator
# blocks non-claude names even with unstableDisableModelVerification on some versions.
MAIN_MODEL="claude-sonnet-4-5"
FAST_MODEL="claude-haiku-4-5"

# ── argument parsing ────────────────────────────────────────────────────────

COMMAND="configure"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    reset)
      COMMAND="reset"
      shift
      ;;
    status)
      COMMAND="status"
      shift
      ;;
    *)
      echo "claude-desktop-glm: unknown argument: $1" >&2
      echo "Run '$0 -h' for usage." >&2
      exit 2
      ;;
  esac
done

# ── preflight ───────────────────────────────────────────────────────────────

preflight() {
  if [[ "$(uname)" != "Darwin" ]]; then
    echo "claude-desktop-glm: macOS only." >&2
    exit 1
  fi
  if [[ ! -d "/Applications/Claude.app" ]]; then
    echo "claude-desktop-glm: /Applications/Claude.app not found. Install from https://claude.ai/download." >&2
    exit 1
  fi
  if [[ ! -x "/usr/bin/jq" ]]; then
    echo "claude-desktop-glm: /usr/bin/jq not found (required on macOS Sonoma+)." >&2
    exit 1
  fi

  local dev_settings="$HOME/Library/Application Support/Claude/developer_settings.json"
  if [[ ! -f "$dev_settings" ]] \
     || ! /usr/bin/jq -e '.allowDevTools == true' "$dev_settings" >/dev/null 2>&1; then
    cat >&2 <<'EOF'
claude-desktop-glm: Developer Mode not enabled in Claude Desktop.

Enable it once in the GUI before running this script:

  1. Open Claude Desktop
  2. Help → Troubleshooting → Enable Developer Mode
  3. Re-run this script
EOF
    exit 1
  fi
}

# ── API key resolution ───────────────────────────────────────────────────────
# Priority: env var → shell rc files → osascript GUI prompt

resolve_api_key() {
  if [[ -n "${ZAI_API_KEY:-}" ]]; then
    printf '%s' "$ZAI_API_KEY"
    return 0
  fi

  local rc found=""
  for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
    [[ -r "$rc" ]] || continue
    found="$(grep -E '^[[:space:]]*export[[:space:]]+ZAI_API_KEY=' "$rc" 2>/dev/null \
      | tail -1 \
      | sed -E 's/^[^=]*=//; s/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/' \
      || true)"
    if [[ -n "$found" ]]; then
      printf '%s' "$found"
      return 0
    fi
  done

  local key
  key="$(osascript <<'APPLESCRIPT' 2>/dev/null || true
try
  set theKey to text returned of (display dialog ¬
    "ZAI_API_KEY not found in env or shell rc.\nPaste your z.ai API Key:" ¬
    default answer "" ¬
    with hidden answer ¬
    with title "claude-desktop-glm")
  return theKey
on error
  return ""
end try
APPLESCRIPT
)"
  if [[ -z "$key" ]]; then
    echo "claude-desktop-glm: no z.ai API Key provided. Aborting." >&2
    exit 1
  fi
  printf '%s' "$key"
}

# ── helpers ──────────────────────────────────────────────────────────────────

confirm_or_abort() {
  echo
  echo "About to: $1"
  echo "Press Enter to continue, Ctrl-C to abort."
  read -r _
}

restart_claude() {
  killall Claude 2>/dev/null || true
  sleep 1
  open -a Claude
}

# ── write gateway entry JSON (atomic temp+mv, no trailing newline) ────────────
# unstableDisableModelVerification bypasses Claude Desktop's local model-name
# block-list. Required for non-Anthropic model names.

write_entry() {
  local uuid="$1"
  local entry_path="$CONFIG_DIR/${uuid}.json"
  local tmp="${entry_path}.tmp"
  local content
  content="$(jq -n \
    --arg baseUrl "$BASE_URL" \
    --arg apiKey  "$GLM_KEY" \
    --arg auth    "$AUTH_SCHEME" \
    --arg main    "$MAIN_MODEL" \
    --arg fast    "$FAST_MODEL" \
    '{
       inferenceProvider: "gateway",
       inferenceGatewayBaseUrl: $baseUrl,
       inferenceGatewayApiKey: $apiKey,
       inferenceGatewayAuthScheme: $auth,
       inferenceModels: [
         {name: $main},
         {name: $fast}
       ],
       coworkEgressAllowedHosts: ["*"]
     }')"
  printf '%s' "$content" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$entry_path"
}

# Upsert $ENTRY_NAME in _meta.json and set appliedId to its uuid.
# Prints the uuid on stdout.
ensure_meta_entry() {
  mkdir -p "$CONFIG_DIR"
  local existing_uuid=""
  if [[ -f "$META" ]]; then
    existing_uuid="$(jq -r --arg name "$ENTRY_NAME" \
      '.entries[]? | select(.name==$name) | .id' "$META" 2>/dev/null \
      | head -1)"
  fi

  local uuid
  if [[ -n "$existing_uuid" ]]; then
    uuid="$existing_uuid"
  else
    uuid="$(uuidgen | tr 'A-Z' 'a-z')"
  fi

  local tmp="${META}.tmp"
  local content
  if [[ -f "$META" ]]; then
    content="$(jq --arg id "$uuid" --arg name "$ENTRY_NAME" '
      .appliedId = $id
      | .entries = ((.entries // []) | map(select(.name != $name)) + [{id: $id, name: $name}])
    ' "$META")"
  else
    content="$(jq -n --arg id "$uuid" --arg name "$ENTRY_NAME" \
      '{appliedId: $id, entries: [{id: $id, name: $name}]}')"
  fi
  printf '%s' "$content" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$META"
  printf '%s' "$uuid"
}

# ── reset: remove claude-desktop-glm entry and clear appliedId ───────────────

cmd_reset() {
  preflight
  if [[ ! -f "$META" ]]; then
    echo "claude-desktop-glm: nothing to reset (_meta.json not found)."
    exit 0
  fi

  local uuid
  uuid="$(jq -r --arg name "$ENTRY_NAME" \
    '.entries[]? | select(.name==$name) | .id' "$META" 2>/dev/null | head -1)"

  if [[ -z "$uuid" ]]; then
    echo "claude-desktop-glm: entry '$ENTRY_NAME' not found in _meta.json. Nothing to do."
    exit 0
  fi

  confirm_or_abort "remove GLM entry '$ENTRY_NAME' from Claude Desktop config and restart."

  [[ -f "$CONFIG_DIR/${uuid}.json" ]] && rm -f "$CONFIG_DIR/${uuid}.json"

  local tmp="${META}.tmp"
  jq --arg id "$uuid" --arg name "$ENTRY_NAME" '
    .entries = ((.entries // []) | map(select(.name != $name)))
    | if .appliedId == $id then del(.appliedId) else . end
  ' "$META" | tr -d '\n' > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$META"

  restart_claude
  echo "Done. GLM entry removed. Claude Desktop is restarting."
}

# ── status: show what is currently applied ───────────────────────────────────

cmd_status() {
  if [[ ! -f "$META" ]]; then
    echo "No config found at: $META"
    exit 0
  fi

  local applied_id entries_count entry_file
  applied_id="$(jq -r '.appliedId // "none"' "$META")"
  entries_count="$(jq '.entries | length' "$META")"

  echo "=== Claude Desktop 3P Config ==="
  echo "Config dir  : $CONFIG_DIR"
  echo "Applied ID  : $applied_id"
  echo "Entries     : $entries_count"
  echo

  if [[ "$applied_id" != "none" ]]; then
    entry_file="$CONFIG_DIR/${applied_id}.json"
    if [[ -f "$entry_file" ]]; then
      echo "--- Active entry ($applied_id) ---"
      jq 'del(.inferenceGatewayApiKey) | . + {inferenceGatewayApiKey: "<redacted>"}' "$entry_file"
    else
      echo "Warning: appliedId points to missing file: $entry_file"
    fi
  fi
}

# ── dispatch ──────────────────────────────────────────────────────────────────

case "$COMMAND" in
  reset)
    cmd_reset
    ;;
  status)
    cmd_status
    ;;
  configure)
    preflight
    GLM_KEY="$(resolve_api_key)"
    confirm_or_abort "configure Claude Desktop to use GLM ($BASE_URL) and restart it."
    UUID="$(ensure_meta_entry)"
    write_entry "$UUID"
    restart_claude

    cat <<'EOF'

Done. Claude Desktop is restarting with GLM (z.ai) as the inference backend.

Models configured (z.ai maps these to GLM on the backend):
  main : claude-sonnet-4-5   → glm-5.1 / glm-4.7
  fast : claude-haiku-4-5    → glm-4.5-air

Heads up: Chat mode is unavailable while a third-party gateway is active.
You'll see Cowork (3P) and Code modes only. To use Chat:

  - At launch chooser, pick "Continue with Anthropic", OR
  - In Developer → Configure Third-Party Inference, toggle off "Skip
    login-mode chooser"

Commands:
  ./scripts/claude-desktop-glm.sh status  # inspect active config
  ./scripts/claude-desktop-glm.sh reset   # revert to Anthropic
EOF
    ;;
esac
