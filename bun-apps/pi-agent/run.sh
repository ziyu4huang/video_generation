#!/usr/bin/env bash
########################################
# run.sh — ONE portable launcher for pi-agent, source OR deployed.
#
# Auto-detects which layout it lives in and picks the right entry, so the SAME
# script works in both places, from any cwd:
#   • Deployed package: pi-agent.js + packages/ present → bun pi-agent.js
#       (run-dir/resolve.ts deploy-package mode resolves extensions from
#        packages/, self-contained via -ne)
#   • Source / dev:     src/cli.ts present               → bun src/cli.ts
#       (run-dir/resolve.ts source mode, additive with .pi/ + ~/.pi/)
#
# USAGE
#   ./run.sh                            # interactive TUI
#   ./run.sh -p "hello"                 # print mode
#   ./run.sh --list-models
#   ./run.sh -e path/to/ext.ts -p "…"   # any pi flag, forwarded untouched
#   PIAGENT_DEBUG=1 ./run.sh …          # print which entry/mode was chosen
#
#   From anywhere (resolves its own dir):
#   cd /anywhere && /abs/path/to/.../run.sh -p hi
#
# UPGRADING pi
#   This launcher runs pi from the npm packages @earendil-works/{pi-agent-core,
#   pi-ai,pi-coding-agent,pi-tui} (workspace deps, pinned to exact versions
#   across bun-apps/*/package.json — these 4 are published in lockstep by the
#   same upstream vendor). pi's built-in `pi update` is DISABLED here
#   (workspace dep, not a global install), so use the dedicated wrapper
#   sibling, or this launcher's thin passthrough:
#
#       ./run.sh --upgrade            # upgrade all 4 to latest (same as below)
#       ./run.sh --upgrade --check    # current vs latest, no change
#       ./run.sh --upgrade --rebuild  # also rebuild pi-agent dist bundle
#       ./bun-apps/pi-agent/update-pi.sh [same flags]   # the actual wrapper
#       ./run.sh --update-help        # print this from the launcher
#
#   The wrapper runs `bun update <all 4 packages> --latest` at the monorepo
#   root in ONE call (so they never drift apart from each other), verifies
#   each installed version, and rewrites bun.lock (the canonical lockfile)
#   for ALL bun-apps/* consumers at once. NEVER use `npm install` — it writes
#   the gitignored package-lock.json and breaks the Bun workspace layout.
#   This file is a symlink target (./pi-agent.sh → here), so editing run.sh
#   updates both invocations.
########################################
set -euo pipefail

# Resolve symlinks so this script works through a symlink (e.g. the repo-root
# ./pi-agent.sh → bun-apps/pi-agent/run.sh convenience launcher). Without this,
# BASH_SOURCE[0] is the symlink path and SCRIPT_DIR lands at the link's dir
# (repo root), where neither pi-agent.js nor src/cli.ts exists → false "no entry"
# error. Portable while-loop (no `readlink -f` — not available on older macOS).
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: 'bun' not found on PATH — install from https://bun.sh" >&2
  exit 1
fi

# Quick update-help: `./run.sh --update-help` prints how to upgrade pi
# without launching the TUI. It just points at the dedicated wrapper — real
# upgrading happens in update-pi.sh (a repo-root bun command), not inside this
# launcher / node_modules.
if [ "${1:-}" = "--update-help" ]; then
  cat <<'EOF'
How to upgrade pi (@earendil-works/pi-agent-core/pi-ai/pi-coding-agent/pi-tui):

  Use the dedicated wrapper (pi's built-in `pi update` is disabled here —
  pi is a workspace dep, not a global install), or ./run.sh --upgrade below:

    ./bun-apps/pi-agent/update-pi.sh            # upgrade all 4 to latest
    ./bun-apps/pi-agent/update-pi.sh --check    # current vs latest only
    ./bun-apps/pi-agent/update-pi.sh --rebuild  # also rebuild pi-agent dist bundle
    ./bun-apps/pi-agent/update-pi.sh --help     # full wrapper docs

  The wrapper runs `bun update <all 4 packages> --latest` at the monorepo
  root in ONE call (they're published in lockstep by the same upstream
  vendor — pinned to exact versions everywhere, so this is the only way
  they change), verifies each version, and bumps bun.lock for all consumers.

  Verify after:  ./pi-agent.sh --list-models

Notes:
  - These 4 packages are workspace deps pinned to exact versions (no "latest"/
    "*"/range in dependencies/devDependencies) — drift only happens via this
    wrapper now, not automatically on every upstream publish.
  - NEVER use `npm install`; it writes the gitignored package-lock.json.
  - This launcher is also reachable via the repo-root symlink ./pi-agent.sh.
EOF
  exit 0
fi

# `./run.sh --upgrade [flags...]` (or `-U`) is a thin passthrough to the
# dedicated wrapper — same script works whether invoked via run.sh or
# directly, and upgrade logic stays in ONE place (update-pi.sh), not
# duplicated here. Any trailing flags (--check/--rebuild/--help) forward as-is.
if [ "${1:-}" = "--upgrade" ] || [ "${1:-}" = "-U" ]; then
  shift
  exec "$SCRIPT_DIR/update-pi.sh" "$@"
fi

ENTRY=""
MODE=""
# Deployed layouts all ship pi-agent.js at the root. Source mode ships
# src/cli.ts instead.
#
# STALE BRANCHES: the `packages/` and `.deploy-portable` arms below are dead.
# deploy.ts accepts only --bundle/--snapshot/--standalone/--exe and writes only
# `.deploy-bundle`/`.deploy-readonly`; no code path produces either marker (the
# unified-deploy design doc says so explicitly:
# docs/superpowers/specs/2026-07-18-unified-deploy-design.md). They survive a
# rename that deploy.ts and the docs completed and the launcher did not — the
# same drift removed from doctor.ts. Left in place only because ripping them out
# also touches run-dir/resolve.ts's `deploy-package` layout mode (a documented
# exported type with its own suite) and 4 tests; that is its own change.
# Do NOT read these arms as evidence that the modes exist.
if [ -f "$SCRIPT_DIR/pi-agent.js" ]; then
  ENTRY="$SCRIPT_DIR/pi-agent.js"
  if [ -f "$SCRIPT_DIR/.deploy-portable" ]; then MODE="deployed (portable)"
  elif [ -d "$SCRIPT_DIR/packages" ]; then MODE="deployed (release)"
  else MODE="deployed (bundle)"; fi
elif [ -f "$SCRIPT_DIR/src/cli.ts" ]; then
  ENTRY="$SCRIPT_DIR/src/cli.ts"
  MODE="source (dev)"
else
  echo "error: no pi-agent entry found in $SCRIPT_DIR" >&2
  echo "       expected src/cli.ts (source) or pi-agent.js (deployed)" >&2
  exit 1
fi

if [ "${PIAGENT_DEBUG:-0}" = "1" ]; then
  echo "[run.sh] mode=$MODE  entry=$ENTRY  cwd=$(pwd)" >&2
fi

# Portable deploy: pin PI_PACKAGE_DIR at the SHIPPED pi-coding-agent in
# node_modules, so pi resolves theme/asset/template paths from here (NOT the
# build-time-baked repo/global-store path — set-package-dir.ts bakes that, and
# it isn't part of the deploy). pi's getPackageDir() looks for
# <pkgDir>/dist/modes/interactive/{theme,assets} + dist/core/export-html, so the
# pin MUST land on the package root (which holds dist/), not the deploy dir.
# `bun install --production` materializes this package into <deploy>/node_modules,
# so the path is stable and repo-independent on the same machine. Respects a
# caller-set value (set-package-dir.ts uses ??=).
#
# DEAD: nothing writes `.deploy-portable` — `deploy.ts --portable` is not a
# flag, it hard-errors with "unknown flag(s)". See the STALE BRANCHES note above.
if [ -f "$SCRIPT_DIR/.deploy-portable" ]; then
  export PI_PACKAGE_DIR="${PI_PACKAGE_DIR:-$SCRIPT_DIR/node_modules/@earendil-works/pi-coding-agent}"
fi

# Read-only deploy (the DEFAULT since deploy.ts freezes every artifact): apply
# the env hardening that lets a chmod-a-w / read-only-prefix deploy actually run.
# All per-user state already routes to ~/.pi/agent (pi sessions/auth +
# pi-hermes-memory's sqlite DB both honor PI_CODING_AGENT_DIR), so the deploy
# tree is never written — but two tweaks are still needed:
#   1. JITI_FS_CACHE=0 — jiti caches compiled .ts to node_modules/.cache/jiti by
#      default; a --snapshot deploy ships the extensions as .ts SOURCE, so that
#      cache write would hit the frozen tree and EACCES. (bundle/standalone ship
#      pre-compiled .js, so this is a no-op there, but it's free insurance.)
#   2. PI_CODING_AGENT_DIR defaults to ~/.pi/agent — pi falls back there anyway,
#      but pinning it explicitly guarantees per-user state never points at the
#      (read-only) deploy tree. Respects a caller-set value.
if [ -f "$SCRIPT_DIR/.deploy-readonly" ]; then
  export JITI_FS_CACHE="${JITI_FS_CACHE:-0}"
  export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
  if [ "${PIAGENT_DEBUG:-0}" = "1" ]; then
    echo "[run.sh] read-only deploy: JITI_FS_CACHE=$JITI_FS_CACHE PI_CODING_AGENT_DIR=$PI_CODING_AGENT_DIR" >&2
  fi
fi

# Source-mode pre-flight dep self-heal: ensure extension workspace deps are
# linked into node_modules BEFORE bun boots. The bun process that loads the
# extensions imports them as bare specifiers (@repo/…, js-yaml,
# @mozilla/readability, …); under Bun's isolated linker those only resolve once
# `bun install` has run. Installing here (in a throwaway process) means the
# subsequent `exec bun` is FRESH and sees the deps on the FIRST launch —
# resolve.ts's mid-boot auto-install can't satisfy the same launch (Bun doesn't
# re-scan node_modules mid-process), which is why ./pi-agent.sh needed a manual
# `bun install` + re-run. check-deps.ts is a silent no-op when nothing's
# missing. Gated to source mode (deploys bake deps in). Opt out with
# BUN_PI_AUTO_INSTALL=0 (passed through to check-deps.ts). `|| true` so a failed
# install still launches pi, which then prints the actionable guide.
if [ -f "$SCRIPT_DIR/src/cli.ts" ] && [ -f "$SCRIPT_DIR/run-dir/check-deps.ts" ]; then
  bun "$SCRIPT_DIR/run-dir/check-deps.ts" || true
fi

# Source-mode layout self-heal (AFTER check-deps so the store target exists):
# this monorepo keeps the Bun workspace at bun-apps/ below the git root, so pi
# boots from a repo-root cwd that has no node_modules. Bun treats the git root
# as the run's project root and, on every launch, materializes a workspace-link
# farm into <git-root>/node_modules (junk: pure symlinks into the global store,
# re-created after every `git clean -dxf`). Pinning a symlink to the REAL
# workspace store satisfies Bun's resolution, so the farm is never built.
# Create-if-missing only — never clobbers an existing dir/link; skipped when
# the git root IS the workspace root (single-workspace-at-top repos, deployed
# layouts) or when the store target is absent (deps broken anyway).
if [ -f "$SCRIPT_DIR/src/cli.ts" ] && command -v git >/dev/null 2>&1; then
  REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
  WORKSPACE_ROOT="$(cd -P "$SCRIPT_DIR/.." && pwd)"
  if [ -n "$REPO_ROOT" ] && [ "$REPO_ROOT" != "$WORKSPACE_ROOT" ] \
      && [ -d "$WORKSPACE_ROOT/node_modules" ] && [ ! -e "$REPO_ROOT/node_modules" ]; then
    ln -s bun-apps/node_modules "$REPO_ROOT/node_modules"
  fi
fi

exec bun "$ENTRY" "$@"
