#!/bin/bash
# Thin wrapper — real logic lives in bun-apps/pi-agent-ext-devops/scripts/ci-local.sh
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bun-apps/pi-agent-ext-devops/scripts/ci-local.sh" "$@"
