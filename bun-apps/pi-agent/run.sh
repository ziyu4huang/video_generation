#!/usr/bin/env bash
########################################
# run.sh — ONE portable launcher for pi-agent, source OR deployed.
#
# Auto-detects which layout it lives in and picks the right entry, so the SAME
# script works in both places, from any cwd:
#   • Deployed package: pi-agent.js + packages/ present → bun pi-agent.js
#       (run-dir/resolve.ts deploy-package mode resolves extensions from
#        packages/, self-contained via -ne)
#   • Source / dev:     src/cli.ts present               → bun src/cli.ts
#       (run-dir/resolve.ts source mode, additive with .pi/ + ~/.pi/)
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
########################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: 'bun' not found on PATH — install from https://bun.sh" >&2
  exit 1
fi

ENTRY=""
MODE=""
# Deployed layouts all ship pi-agent.js at the root: --release (packages/),
# default bundle (ext-bundles/), --portable (ext-bundles/ + node_modules/).
# Source mode ships src/cli.ts instead.
if [ -f "$SCRIPT_DIR/pi-agent.js" ]; then
  ENTRY="$SCRIPT_DIR/pi-agent.js"
  if [ -f "$SCRIPT_DIR/.deploy-portable" ]; then MODE="deployed (portable)"
  elif [ -d "$SCRIPT_DIR/packages" ]; then MODE="deployed (release)"
  else MODE="deployed (bundle)"; fi
elif [ -f "$SCRIPT_DIR/src/cli.ts" ]; then
  ENTRY="$SCRIPT_DIR/src/cli.ts"
  MODE="source (dev)"
else
  echo "error: no pi-agent entry found in $SCRIPT_DIR" >&2
  echo "       expected src/cli.ts (source) or pi-agent.js (deployed)" >&2
  exit 1
fi

if [ "${PIAGENT_DEBUG:-0}" = "1" ]; then
  echo "[run.sh] mode=$MODE  entry=$ENTRY  cwd=$(pwd)" >&2
fi

# Portable deploy: pin PI_PACKAGE_DIR to the deploy dir so pi resolves
# theme/asset/template paths from here (NOT the build-time-baked repo path).
# set-package-dir.ts respects a pre-set value (it uses ??=). The .deploy-portable
# marker is written by `scripts/deploy.ts --portable`.
if [ -f "$SCRIPT_DIR/.deploy-portable" ]; then
  export PI_PACKAGE_DIR="$SCRIPT_DIR"
fi

# Read-only deploy (the DEFAULT since deploy.ts freezes every artifact): apply
# the env hardening that lets a chmod-a-w / read-only-prefix deploy actually run.
# All per-user state already routes to ~/.pi/agent (pi sessions/auth +
# pi-hermes-memory's sqlite DB both honor PI_CODING_AGENT_DIR), so the deploy
# tree is never written — but two tweaks are still needed:
#   1. JITI_FS_CACHE=0 — jiti caches compiled .ts to node_modules/.cache/jiti by
#      default; in --release mode the extensions ARE .ts source, so that cache
#      write would hit the frozen tree and EACCES. (bundle/portable ship
#      pre-compiled .js, so this is a no-op there, but it's free insurance.)
#   2. PI_CODING_AGENT_DIR defaults to ~/.pi/agent — pi falls back there anyway,
#      but pinning it explicitly guarantees per-user state never points at the
#      (read-only) deploy tree. Respects a caller-set value.
if [ -f "$SCRIPT_DIR/.deploy-readonly" ]; then
  export JITI_FS_CACHE="${JITI_FS_CACHE:-0}"
  export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
  if [ "${PIAGENT_DEBUG:-0}" = "1" ]; then
    echo "[run.sh] read-only deploy: JITI_FS_CACHE=$JITI_FS_CACHE PI_CODING_AGENT_DIR=$PI_CODING_AGENT_DIR" >&2
  fi
fi

exec bun "$ENTRY" "$@"
