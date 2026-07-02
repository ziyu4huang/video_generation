#!/usr/bin/env bash
# One-time repo setup — run after a fresh clone.
# Enables the shared pre-commit hook (2 MB size guard) committed at .githooks/.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ -d .githooks ]; then
  git config core.hooksPath .githooks
  echo "✓ hooks enabled (core.hooksPath = .githooks)"
  echo "  pre-commit guard: rejects files > 2 MB (bypass: git commit --no-verify)"
else
  echo "✗ .githooks/ not found at $REPO_ROOT — aborting" >&2
  exit 1
fi
