#!/usr/bin/env bash
########################################
# update-superpowers.sh — sync superpowers skills/ from the plugin cache
# (upstream verbatim). The whole upstream-convergence flow is self-contained in
# the superpowers ext folder; bun-apps/s2-agent/update-pi.sh is unrelated (it
# only locks the pi-* core). Local divergence is handled at the boundary layer
# (src/superpowers.ts piBoundaryOverrides, ADR-0005), never by patching skills.
#
# SYNC SOURCE: the plugin cache ($CLAUDE_PLUGINS_CACHE) is the CANONICAL sync
# source — the blessed release artifact matching what Claude Code users receive.
# The upstream git origin obra/superpowers may be checked out locally at
# ../superpowers/ for REFERENCE ONLY (reading upstream to understand it); it is
# NEVER a sync source. The fidelity tests (skills-fidelity.test.ts + UPSTREAM.ref)
# catch drift regardless of source.
#
# USAGE
#   ./bun-apps/s2-agent-ext-superpowers/scripts/update-superpowers.sh [version]
#     version  plugin version to sync (default: newest under the cache).
#   CLAUDE_PLUGINS_CACHE  override the plugin cache root.
########################################
set -euo pipefail

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # s2-agent-ext-superpowers/
CACHE="${CLAUDE_PLUGINS_CACHE:-$HOME/.claude-glm/plugins/cache/claude-plugins-official/superpowers}"

if [[ $# -ge 1 ]]; then
  VER="$1"
else
  VER="$(ls -1 "$CACHE" 2>/dev/null | sort -V | tail -1)"
fi
[[ -n "$VER" ]] || { echo "error: no superpowers plugin cache at $CACHE" >&2; exit 1; }
SRC="$CACHE/$VER/skills"
[[ -d "$SRC" ]] || { echo "error: $SRC not found" >&2; exit 1; }

echo "▶ sync skills/ from $CACHE/$VER"
rm -rf "$PKG/skills"
cp -R "$SRC" "$PKG/skills"

echo
echo "done. review the diff:  git diff bun-apps/s2-agent-ext-superpowers/skills/"
