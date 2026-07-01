#!/usr/bin/env bash
########################################
# run.sh — ONE portable launcher for pi-agent, source OR deployed.
#
# WHY THIS EXISTS
#   `bun bun-apps/pi-agent/src/cli.ts` only works from the repo root (relative
#   path breaks elsewhere). And the deployed package (scripts/deploy.ts) runs a
#   different entry — `bun pi-agent.js` (the bundle). This script auto-detects
#   which layout it lives in and picks the right entry, so the SAME run.sh
#   works in both places, from any cwd:
#
#     • Deployed package (bundle): pi-agent.js + .pi-deploy-marker.json present
#         → exec bun pi-agent.js   (cli.ts's deploy-mode then injects the
#           baked extensions via -ne + -e; uses the package's node_modules)
#     • Source / dev (repo):        src/cli.ts present
#         → exec bun src/cli.ts     (uses the repo's node_modules; loads
#           extensions from the repo's .pi/settings.json)
#
#   The correct node_modules / runtime resolution follows automatically from
#   the entry chosen — no manual switching.
#
# USAGE
#   ./run.sh                            # interactive TUI
#   ./run.sh -p "hello"                 # print mode
#   ./run.sh --list-models
#   ./run.sh -e path/to/ext.ts -p "…"   # any pi flag, forwarded untouched
#   PIAGENT_DEBUG=1 ./run.sh …          # print which entry/mode was chosen
#
#   From anywhere (resolves its own dir):
#   cd /anywhere && /abs/path/to/.../run.sh -p hi
#
#   Alias in ~/.zshrc:
#   alias pi='/abs/path/to/bun-apps/pi-agent/run.sh'
########################################
set -euo pipefail

# Resolve the directory of this script (works from any cwd). BASH_SOURCE handles
# both `bash run.sh` and `./run.sh`.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: 'bun' not found on PATH — install from https://bun.sh" >&2
  exit 1
fi

# ── Detect layout → pick entry ──────────────────────────────────────────────
# Deployed bundle takes precedence: a deploy dir ALSO contains src/cli.ts is
# not expected, but if both somehow exist the marker is authoritative.
ENTRY=""
MODE=""
if [ -f "$SCRIPT_DIR/pi-agent.js" ] && [ -f "$SCRIPT_DIR/.pi-deploy-marker.json" ]; then
  ENTRY="$SCRIPT_DIR/pi-agent.js"
  MODE="deployed (bundle)"
elif [ -f "$SCRIPT_DIR/src/cli.ts" ]; then
  ENTRY="$SCRIPT_DIR/src/cli.ts"
  MODE="source (dev)"
else
  echo "error: no pi-agent entry found in $SCRIPT_DIR" >&2
  echo "       expected either src/cli.ts (source) or pi-agent.js + .pi-deploy-marker.json (deployed)" >&2
  exit 1
fi

if [ "${PIAGENT_DEBUG:-0}" = "1" ]; then
  echo "[run.sh] mode=$MODE  entry=$ENTRY  cwd=$(pwd)" >&2
fi

# exec: bun replaces this process so signals / Ctrl-C propagate cleanly.
exec bun "$ENTRY" "$@"
