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
#   This launcher runs pi from the npm package @earendil-works/pi-coding-agent
#   (a workspace dep; specs vary across bun-apps/*/package.json). pi's built-in `pi update`
#   is DISABLED here (workspace dep, not a global install), so use the dedicated
#   wrapper sibling:
#
#       ./bun-apps/pi-agent/update-pi.sh            # upgrade pi to latest
#       ./bun-apps/pi-agent/update-pi.sh --check    # current vs latest, no change
#       ./bun-apps/pi-agent/update-pi.sh --rebuild  # also rebuild pi-agent dist bundle
#       ./run.sh --update-help                      # print this from the launcher
#
#   The wrapper runs `bun update @earendil-works/pi-coding-agent --latest` at
#   the monorepo root, verifies the installed version, and rewrites bun.lock
#   (the canonical lockfile) for ALL bun-apps/* consumers at once. NEVER use
#   `npm install` — it writes the gitignored package-lock.json and breaks the
#   Bun workspace layout. This file is a symlink target (./pi-agent.sh → here),
#   so editing run.sh updates both invocations.
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

# Quick update-help: `./run.sh --update-help` (or `-U`) prints how to upgrade
# pi without launching the TUI. It just points at the dedicated wrapper — real
# upgrading happens in update-pi.sh (a repo-root bun command), not inside this
# launcher / node_modules.
if [ "${1:-}" = "--update-help" ] || [ "${1:-}" = "-U" ]; then
  cat <<'EOF'
How to upgrade pi (@earendil-works/pi-coding-agent):

  Use the dedicated wrapper (pi's built-in `pi update` is disabled here —
  pi is a workspace dep, not a global install):

    ./bun-apps/pi-agent/update-pi.sh            # upgrade to latest
    ./bun-apps/pi-agent/update-pi.sh --check    # current vs latest only
    ./bun-apps/pi-agent/update-pi.sh --rebuild  # also rebuild pi-agent dist bundle
    ./bun-apps/pi-agent/update-pi.sh --help     # full wrapper docs

  The wrapper runs `bun update @earendil-works/pi-coding-agent --latest` at the
  monorepo root, verifies the version, and bumps bun.lock for all consumers.

  Verify after:  ./pi-agent.sh --list-models

Notes:
  - pi is a workspace dep; specs vary ("latest"/"*"/ranges) — no version to edit by hand.
  - NEVER use `npm install`; it writes the gitignored package-lock.json.
  - This launcher is also reachable via the repo-root symlink ./pi-agent.sh.
EOF
  exit 0
fi

ENTRY=""
MODE=""
# Deployed layouts all ship pi-agent.js at the root: --release (packages/),
# default bundle (ext-bundles/), --portable (ext-bundles/ + node_modules/).
# Source mode ships src/cli.ts instead.
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
# caller-set value (set-package-dir.ts uses ??=). The .deploy-portable marker is
# written by `scripts/deploy.ts --portable`.
if [ -f "$SCRIPT_DIR/.deploy-portable" ]; then
  export PI_PACKAGE_DIR="${PI_PACKAGE_DIR:-$SCRIPT_DIR/node_modules/@earendil-works/pi-coding-agent}"
fi

# Read-only deploy (the DEFAULT since deploy.ts freezes every artifact): apply
# the env hardening that lets a chmod-a-w / read-only-prefix deploy actually run.
# All per-user state already routes to ~/.pi/agent (pi sessions/auth +
# pi-hermes-memory's sqlite DB both honor PI_CODING_AGENT_DIR), so the deploy
# tree is never written — but two tweaks are still needed:
#   1. JITI_FS_CACHE=0 — jiti caches compiled .ts to node_modules/.cache/jiti by
#      default; in --release mode the extensions ARE .ts source, so that cache
#      write would hit the frozen tree and EACCES. (bundle/portable ship
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

exec bun "$ENTRY" "$@"
