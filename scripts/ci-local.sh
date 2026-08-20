#!/bin/bash
# Thin wrapper — real logic lives in bun-apps/s2-agent-ext-devops/scripts/ci-local.sh
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bun-apps/s2-agent-ext-devops/scripts/ci-local.sh" "$@"
