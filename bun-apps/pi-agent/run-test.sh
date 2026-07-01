#!/usr/bin/env bash
########################################
# run-test.sh — run pi-agent's FULL test suite, INCLUDING bundle e2e.
#
# Plain `bun test` runs only the pure-function unit tests; the bundle-mode e2e
# (src/__tests__/e2e-patches.test.ts + e2e-extensions.test.ts) is gated on
# PI_AGENT_E2E=1 so the pre-extension-dev baseline stays fast. This launcher
# sets that flag, so the e2e actually fires: it builds dist/pi-agent/pi-agent.js
# and spawns it to verify the monkey-patches + extension loading work end-to-end.
#
# USAGE
#   ./run-test.sh                          # full suite (unit + bundle e2e)
#   ./run-test.sh src/__tests__/e2e-patches.test.ts   # one file
#   PI_AGENT_E2E_NO_BUILD=1 ./run-test.sh  # reuse an existing dist bundle
#   args after the first are forwarded to `bun test` untouched
#
# Run from anywhere (resolves its own dir, then cds into the package so the
# relative test paths resolve). Exit code is bun test's.
########################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: 'bun' not found on PATH — install from https://bun.sh" >&2
  exit 1
fi

export PI_AGENT_E2E=1

# Optional: skip the rebuild and reuse dist/pi-agent/pi-agent.js (faster re-runs).
if [ "${PI_AGENT_E2E_NO_BUILD:-0}" = "1" ]; then
  echo "[run-test.sh] PI_AGENT_E2E_NO_BUILD=1 — reusing existing dist bundle (if present)" >&2
fi

echo "[run-test.sh] PI_AGENT_E2E=1 — full suite incl. bundle e2e (builds dist/)" >&2

cd "$SCRIPT_DIR"
exec bun test "$@"
