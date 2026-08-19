#!/usr/bin/env bash
########################################
# run-sh-agent-e2e.sh — L2/L3 e2e for a pi-agent-sh deploy.
#
#   L2 (default): the deployed binary + a REAL model turn. The agent must call
#     a deployed tool (todo) and the provider must accept it — this is the tier
#     that catches a tool schema the provider rejects (the z.ai "Invalid schema
#     for function 'todo': type: null" 400) and a tool that registers but dies
#     on first execute. L1 (deploy-sh-probe-e2e.test.ts) proves registration;
#     only L2 proves execution.
#
#   L3 (--tui): the deployed binary's interactive TUI under a real pty
#     (`script -q` + stty give stdin/stdout a tty). Asserts the banner lists
#     the deployed extensions and skills and that no sdk-patch warning fired.
#
# TEXT MODE, NOT --mode json (measured): --mode json truncates output after the
# first tool call (source mode too) — pre-existing, not deploy-caused — so a
# JSON-parsing harness would fail for the wrong reason. Text mode streams the
# full transcript; assertions are greps over it.
#
# OPT-IN: L2 spends tokens and hits the network; NOT wired into CI (same policy
# as run-ext-e2e.sh).
#
# USAGE
#   bash bun-apps/pi-agent/scripts/run-sh-agent-e2e.sh           # L2, fresh deploy to a temp dir
#   bash bun-apps/pi-agent/scripts/run-sh-agent-e2e.sh --tui     # L3 pty smoke
#   DEPLOY_DIR=~/proj/dist/pi-agent-sh/current \
#     bash bun-apps/pi-agent/scripts/run-sh-agent-e2e.sh         # reuse an existing deploy
########################################
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# scripts/ → pi-agent/ → bun-apps/ → repo root (three levels up).
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DEVOPS="$REPO_ROOT/bun-apps/pi-agent-ext-devops"

MODE="l2"
[ "${1:-}" = "--tui" ] && MODE="tui"

TMP="$(mktemp -d)"
# The deploy freezes its tree (chmod a-w) by default; a bare rm -rf then fails
# on read-only files and leaves the temp dir behind. --no-freeze below avoids
# creating the problem; the chmod is belt-and-braces for DEPLOY_DIR edge cases.
trap 'chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT

# ── Resolve the deployed binary ─────────────────────────────────────────────
if [ -n "${DEPLOY_DIR:-}" ]; then
  BINARY="$DEPLOY_DIR/pi-agent"
  if [ ! -x "$BINARY" ]; then
    echo "error: DEPLOY_DIR set but $BINARY is not executable" >&2
    exit 1
  fi
  echo "── reusing deploy: $DEPLOY_DIR ──"
else
  echo "── deploying sh bundle to $TMP ──"
  # Call the CLI directly — `bun run deploy:sh` would first echo its command
  # line to stdout and pollute the JSON. deploy-sh-cli promises PURE JSON on
  # stdout (that convention is what makes this parse safe — the build report
  # goes to stderr). --no-freeze keeps the tree removable by the EXIT trap.
  if ! bun "$DEVOPS/src/deploy-sh-cli.ts" --out "$TMP" --no-freeze > "$TMP/deploy.json" 2> "$TMP/deploy.err"; then
    echo "error: deploy failed:" >&2
    cat "$TMP/deploy.err" >&2
    exit 1
  fi
  # JSON: { ok: true, target: "<versioned deploy dir>", … } — runShDeploy's result.
  CURRENT="$(python3 -c "import json;print(json.load(open('$TMP/deploy.json'))['target'])")"
  BINARY="$CURRENT/pi-agent"
  if [ ! -x "$BINARY" ]; then
    echo "error: deploy reported ok but $BINARY is not executable" >&2
    exit 1
  fi
fi

# L3 needs no model, so it runs against a throwaway PI_CODING_AGENT_DIR and
# never touches shared ~/.pi state. L2 DOES need the operator's real model
# credentials (a temp dir has none — measured: 401 Invalid bearer token), the
# same shared-state policy as run-ext-e2e.sh.
if [ "$MODE" = "tui" ]; then
  export PI_CODING_AGENT_DIR="$TMP/pi-home"
fi

FAILED=0
note_fail() { echo "✗ $1"; FAILED=1; }

# ── L2: one real agent turn that must call the todo tool ────────────────────
if [ "$MODE" = "l2" ]; then
  LOG="$TMP/agent.log"
  echo "── L2: agent turn against $BINARY (real model) ──"
  # Capture to a log, THEN grep the file — never `… | grep -q` under pipefail
  # (grep -q closes the pipe on first match; the producer dies on SIGPIPE and
  # pipefail turns 141 into the pipeline's status — a green run reported ✗).
  # ANTHROPIC_* overrides are scrubbed: the deploy's model defaults are z.ai
  # GLM (builtin-model-default), but a wrapper/proxied environment exporting
  # ANTHROPIC_BASE_URL/AUTH_TOKEN hijacks provider selection and the turn dies
  # with the proxy's 401 before any tool schema reaches a real provider.
  env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL \
      -u ANTHROPIC_DEFAULT_HAIKU_MODEL -u ANTHROPIC_DEFAULT_OPUS_MODEL \
      -u ANTHROPIC_DEFAULT_SONNET_MODEL \
    "$BINARY" -p "Call the todo tool: create a task with subject 'sh-l2-e2e-smoke', then list the todos and tell me what you created." \
    > "$LOG" 2>&1 || true

  if grep -q "todo" "$LOG" && grep -q "sh-l2-e2e-smoke" "$LOG"; then
    echo "✓ todo tool executed by the deployed extension"
  else
    note_fail "todo tool never ran (no todo/sh-l2-e2e-smoke in transcript) — see $LOG"
  fi
  if grep -Eq "Invalid schema|Error: 400" "$LOG"; then
    note_fail "provider rejected a tool schema — see $LOG"
  else
    echo "✓ provider accepted the tool schemas"
  fi
  if grep -q "sdk-patch" "$LOG"; then
    note_fail "sdk-patch warning fired — polyfill dead again — see $LOG"
  else
    echo "✓ no sdk-patch warning"
  fi

# ── L3: the interactive TUI under a real pty ────────────────────────────────
else
  LOG="$TMP/tui.log"
  echo "── L3: pty TUI smoke against $BINARY ──"
  # `script -q <file> <cmd>` runs the binary with a pty on stdin/stdout and
  # records the session to <file> (the -q /dev/null variant prints instead).
  # stty pins a sane size inside the pty; the TUI renders differently (or not
  # at all) against a zero-size terminal. A TUI that ignores /exit and EOF
  # must fail the assertions, not hang the harness — a watchdog kills the
  # session after TUI_TIMEOUT (default 25s) and the greps judge the recording.
  # pkill targets this run's unique temp path, never another pi-agent.
  TUI_TIMEOUT="${TUI_TIMEOUT:-25}"
  { sleep 8; printf '/exit\r'; sleep 2; printf '\004'; sleep 2; } \
    | script -q "$LOG" sh -c "stty rows 40 cols 120 2>/dev/null; exec '$BINARY'" \
    >/dev/null 2>&1 &
  PTY_PID=$!
  ( sleep "$TUI_TIMEOUT"; pkill -f "$BINARY" 2>/dev/null; kill "$PTY_PID" 2>/dev/null ) &
  WATCHDOG=$!
  disown "$WATCHDOG" 2>/dev/null || true
  wait "$PTY_PID" 2>/dev/null || true
  kill "$WATCHDOG" 2>/dev/null || true
  pkill -f "$BINARY" 2>/dev/null || true

  # The banner renders the label and the list on separate lines (label, then an
  # indented grey list) with ANSI codes in between — assert them independently
  # rather than as one joined string.
  for needle in "\\[Extensions\\]" "<inline:power-tool>, <inline:task>" "\\[Skills\\]"; do
    if grep -q "$needle" "$LOG"; then
      echo "✓ TUI shows $needle"
    else
      note_fail "TUI missing '$needle' — see $LOG"
    fi
  done
  for skill in btw playwright-cli webui-audit; do
    if grep -q "$skill" "$LOG"; then
      echo "✓ skill listed: $skill"
    else
      note_fail "skill '$skill' not listed — see $LOG"
    fi
  done
  if grep -q "sdk-patch" "$LOG"; then
    note_fail "sdk-patch warning fired at startup — see $LOG"
  else
    echo "✓ no sdk-patch warning at startup"
  fi
fi

if [ "$FAILED" -ne 0 ]; then
  echo "── FAIL — transcript kept:" >&2
  cp "$LOG" "/tmp/run-sh-agent-e2e-$(date +%s).log" 2>/dev/null || true
  exit 1
fi
echo "── ok ($MODE) ──"
exit 0
