#!/usr/bin/env bash
# One-time repo setup — run after a fresh clone, and again in each new worktree.
#  1. Points core.hooksPath at .githooks/ (pre-commit + pre-push).
#  2. Normalizes submodule config + initializes submodules (private repos —
#     needs SSH auth to github.com).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ -d .githooks ]; then
  # RELATIVE on purpose. git resolves a relative core.hooksPath against the
  # top-level of the working tree the hook is running in, so every linked
  # worktree gets its OWN .githooks/. An ABSOLUTE value silently points every
  # worktree at one checkout's copy: edit a hook on a branch in worktree B and
  # the hook that actually runs is still worktree A's. core.hooksPath lives in
  # the SHARED config, so one bad `git config` breaks it for all of them.
  # Re-running this script repairs that — which is why it is worth re-running
  # in a new worktree even though "one-time setup" suggests otherwise.
  prev="$(git config --get core.hooksPath || true)"
  if [ -n "$prev" ] && [ "$prev" != ".githooks" ]; then
    echo "· core.hooksPath was '$prev' — repointing to the relative '.githooks'"
    echo "  (an absolute or foreign path makes every worktree run one checkout's hooks)"
  fi
  git config core.hooksPath .githooks
  echo "✓ hooks enabled (core.hooksPath = .githooks)"
  echo "  pre-commit: rejects files > 2 MB          (bypass: git commit --no-verify)"
  echo "  pre-push:   runs the CI regression-gates  (bypass: git push --no-verify)"
  echo "              — 13 structural guards, ~6s; see .githooks/pre-push"
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
