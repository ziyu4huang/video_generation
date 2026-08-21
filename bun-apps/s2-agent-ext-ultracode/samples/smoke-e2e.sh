#!/usr/bin/env bash
########################################
# smoke-e2e.sh — the REAL end-to-end smoke for dynamic-workflows.
#
# Drives the full stack the way a user actually invokes it:
#   s2-agent CLI  →  -e ultracode (alias-resolved)  →  the `workflow` TOOL
#   →  the model calls it with the smoke script  →  background:false inline result.
#
# This is the same path as:
#   bun bun-apps/s2-agent/src/cli.ts -e ultracode -p "<prompt>"
# …but deterministic: it feeds a FIXED script (default samples/dynamic-workflow-
# smoke01.js) instead of letting the model invent a 4-phase workflow, so the run
# takes seconds, not minutes.
#
# Contrast with samples/run.ts, which calls runWorkflow() DIRECTLY (library
# level) — useful and faster, but it bypasses the CLI / argv parsing / the
# workflow tool, so it is NOT full e2e. This script is.
#
# USAGE (from anywhere):
#   ./bun-apps/s2-agent-ext-ultracode/samples/smoke-e2e.sh [workflow.js]
#   PI_MODEL=google/gemma-4-12b ./.../smoke-e2e.sh
########################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# samples/ -> s2-agent-ext-ultracode/ -> bun-apps/ -> repo root
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CLI="$REPO_ROOT/bun-apps/s2-agent/src/cli.ts"

MODEL="${PI_MODEL:-google/gemma-4-12b}"
WF="${1:-$SCRIPT_DIR/dynamic-workflow-smoke01.js}"

if [ ! -f "$WF" ]; then
	echo "workflow file not found: $WF" >&2
	exit 2
fi

WF_SCRIPT="$(cat "$WF")"

# Strict prompt: force the model to relay the exact script and run it inline
# (background:false) so the result returns in the same turn — no detached run.
PROMPT="Call the workflow tool now with background=false and this EXACT script value (do not modify it, do not wrap in fences, do not write your own script):

$WF_SCRIPT

Return only the workflow result."

exec bun "$CLI" -e ultracode --model "$MODEL" -p "$PROMPT"
