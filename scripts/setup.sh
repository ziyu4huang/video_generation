#!/usr/bin/env bash
# One-time repo setup — run after a fresh clone.
#  1. Enables the shared pre-commit hook (2 MB size guard) at .githooks/.
#  2. Normalizes submodule config + initializes submodules (private repos —
#     needs SSH auth to github.com).
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

# ── Submodules ───────────────────────────────────────────────────────────────
# Defensive: a malformed *empty* `submodule.active` in .git/config makes
# `git submodule status` abort with "empty string is not a valid pathspec"
# (local-only corruption — no tracked script writes it; see goal P2a).
# Unset it so status stays callable.
if git config --get submodule.active >/dev/null 2>&1 && \
   [ -z "$(git config --get submodule.active)" ]; then
  git config --unset submodule.active
  echo "✓ repaired malformed empty submodule.active"
fi
# Best-effort init: private submodule URLs (git@github.com:…) need SSH auth.
# Do NOT abort setup if checkout fails — hooks above are the critical step.
if git submodule update --init --recursive >"/tmp/${USER}-sub-init.log" 2>&1; then
  echo "✓ submodules initialized ($(git submodule status | wc -l | tr -d ' '))"
else
  echo "⚠ submodule init failed (private repos need SSH auth to github.com)"
  echo "  retry later:  git submodule update --init --recursive"
  echo "  log: /tmp/${USER}-sub-init.log"
fi
