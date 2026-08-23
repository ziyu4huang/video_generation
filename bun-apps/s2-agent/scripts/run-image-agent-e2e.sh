#!/usr/bin/env bash
########################################
# run-image-agent-e2e.sh — REAL-MODEL integration e2e for the image agent.
#
# Spawns ./s2-agent.sh with a natural-language prompt that drives the flux2 tool
# (auto-loaded via run-dir/manifest.json) and asserts: a zh-TW reply + a new
# timestamped PNG under output/flux-output/. This is the layer above the offline
# probe (e2e-extensions) and the L2 judgment workflow (run-ext-e2e.sh).
#
# OPT-IN. Spends LLM tokens + minutes (loads a 9B model). Deliberately NOT wired
# into run-test.ts / CI — a flaky model reply must never fail a build.
#
# USAGE
#   bash bun-apps/s2-agent/scripts/run-image-agent-e2e.sh
#   PI_AGENT_E2E_MODEL=google/gemma-4-12b bash bun-apps/s2-agent/scripts/run-image-agent-e2e.sh
#   PI_AGENT_E2E_PROMPT="verify I can use the Flux tool, reply in zh-TW, generate <X> to ./output/flux-output/<name>-<timestamp>.png and open it" \
#     bash bun-apps/s2-agent/scripts/run-image-agent-e2e.sh
#
# ENV
#   PI_AGENT_E2E_MODEL       model id (default: google/gemma-4-12b)
#   PI_AGENT_E2E_PROMPT      override the NL prompt (default: neutral Japanese-garden subject)
#   PI_AGENT_E2E_TIMEOUT_MS  per-run kill timeout (default: 600000)
########################################
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# scripts/ → s2-agent/ → bun-apps/ → repo root (three levels up).
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: 'bun' not found on PATH — install from https://bun.sh" >&2
  exit 1
fi

# Preflight: flux2 binary + metallib must exist (the test skips gracefully too,
# but failing here is faster and clearer).
FLUX2_BIN="$REPO_ROOT/swift/flux2-image-director/.build/release/flux2"
METALIB="$REPO_ROOT/swift/flux2-image-director/.build/release/mlx.metallib"
if [ ! -x "$FLUX2_BIN" ] || [ ! -f "$METALIB" ]; then
  echo "error: flux2 binary or metallib missing." >&2
  echo "  want: $FLUX2_BIN" >&2
  echo "  want: $METALIB" >&2
  echo "  build: ( cd swift/flux2-image-director && swift build -c release ) && bash swift/flux2-image-director/scripts/build-metallib.sh" >&2
  exit 1
fi

export PI_AGENT_E2E_IMAGE=1
# Default model mirrors the operator's canonical example.
: "${PI_AGENT_E2E_MODEL:=google/gemma-4-12b}"

echo "▶ image-agent integration e2e (model=$PI_AGENT_E2E_MODEL)"
echo "  prompt default: neutral subject; override via PI_AGENT_E2E_PROMPT"

# Run only this test file (it self-skips without PI_AGENT_E2E_IMAGE, which we set).
( cd "$SCRIPT_DIR/.." && bun test src/__tests__/e2e-image-agent.test.ts "$@" )
rc=$?

if [ "$rc" -eq 0 ]; then
  echo "✓ image-agent e2e passed"
else
  echo "✗ image-agent e2e failed (rc=$rc)"
fi
exit "$rc"
