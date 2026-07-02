#!/usr/bin/env bash
########################################
# run.sh — ONE portable launcher for pi-agent-cli, source OR deployed.
#
# Auto-detects which layout it lives in and picks the right entry, so the SAME
# script works in both places, from any cwd:
#   • Compiled exe:  pi-agent-cli binary present        → ./pi-agent-cli
#       (bun --compile output; fully standalone, no bun needed at runtime)
#   • Deployed:      pi-agent-cli.js / cli.js present   → bun <bundle>
#       (the dist/pi-agent-cli-deploy/ layout from `bun scripts/build.ts --deploy`)
#   • Source / dev:  src/cli.ts present                 → bun src/cli.ts
#       (hot dev; reads the repo's workspace deps via the node_modules symlink)
#
# USAGE
#   ./run.sh vlm-describe paper.pdf
#   ./run.sh zk-extract notes.md --folder Zettelkasten
#   ./run.sh --list-models
#   ./run.sh doctor
#   ./run.sh -p "summarize this"           # any pi-compat flags, forwarded untouched
#   PICLI_DEBUG=1 ./run.sh …                # print which entry/mode was chosen
#
#   From anywhere (resolves its own dir):
#   cd /anywhere && /abs/path/to/.../run.sh --list-tools
########################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ENTRY=""
MODE=""
RUNNER=""   # "" = direct exec (compiled exe), "bun" = needs bun runtime

# Prefer the compiled standalone exe first (no bun dependency at runtime).
if [ -f "$SCRIPT_DIR/pi-agent-cli" ] && [ -x "$SCRIPT_DIR/pi-agent-cli" ]; then
	ENTRY="$SCRIPT_DIR/pi-agent-cli"
	MODE="compiled-exe"
elif [ -f "$SCRIPT_DIR/pi-agent-cli.js" ]; then
	ENTRY="$SCRIPT_DIR/pi-agent-cli.js"
	MODE="deployed (bundle)"
	RUNNER="bun"
elif [ -f "$SCRIPT_DIR/cli.js" ]; then
	ENTRY="$SCRIPT_DIR/cli.js"
	MODE="deployed (bundle)"
	RUNNER="bun"
elif [ -f "$SCRIPT_DIR/src/cli.ts" ]; then
	ENTRY="$SCRIPT_DIR/src/cli.ts"
	MODE="source (dev)"
	RUNNER="bun"
else
	echo "error: no pi-agent-cli entry found in $SCRIPT_DIR" >&2
	echo "       expected src/cli.ts (source), cli.js / pi-agent-cli.js (deployed)," >&2
	echo "       or pi-agent-cli (compiled exe)" >&2
	exit 1
fi

# bun is only required for the non-compiled entries.
if [ "$RUNNER" = "bun" ] && ! command -v bun >/dev/null 2>&1; then
	echo "error: 'bun' not found on PATH — install from https://bun.sh" >&2
	exit 1
fi

if [ "${PICLI_DEBUG:-0}" = "1" ]; then
	echo "[run.sh] mode=$MODE  entry=$ENTRY  runner=${RUNNER:-<direct>}  cwd=$(pwd)" >&2
fi

if [ "$RUNNER" = "bun" ]; then
	exec bun "$ENTRY" "$@"
else
	exec "$ENTRY" "$@"
fi
