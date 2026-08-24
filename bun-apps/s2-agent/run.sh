#!/usr/bin/env bash
########################################
# run.sh — the launcher for s2-agent FROM THE REPO, runnable from any cwd.
#
# RENAME NOTE: s2-agent = renamed pi-agent (2026-08-21); upstream deps still
# @earendil-works/pi-*; update flow unchanged (update-pi.sh). The repo-root
# ./pi-agent.sh is kept as a deprecated compat alias → ./s2-agent.sh → here.
#
# Entry is src/cli.ts (src/run-dir/resolve.ts source mode, additive with .pi/ +
# ~/.pi/). The deployed artifact does not come through here: the s2-agent-sh
# tree ships its own run.sh beside a self-contained binary.
#
# It used to auto-detect a second layout — a deployed `s2-agent.js` — but its
# producer and the runtime that resolved it are both gone (#1740, Phase 1b).
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
#       ./run.sh --upgrade --rebuild  # also cut a new versioned deploy
#       ./bun-apps/s2-agent/update-pi.sh [same flags]   # the actual wrapper
#       ./run.sh --update-help        # print this from the launcher
#
#   The wrapper rewrites the exact version pins for all 4 packages across
#   every bun-apps/*/package.json in one pass (perl in-place edit —
#   `bun update --latest` cannot fix sub-workspace exact pins in bun 1.3.x),
#   reconciles bun.lock, verifies each installed version, and lockstep-checks
#   every consumer. NEVER use `npm install` — it writes the gitignored
#   package-lock.json and breaks the Bun workspace layout.
#   This file is a symlink target (./s2-agent.sh → here), so editing run.sh
#   updates both invocations.
########################################
set -euo pipefail

# Deprecated-name notice: invoked through the repo-root compat symlink
# ./pi-agent.sh → ./s2-agent.sh → here. stderr-only, non-fatal.
case "$(basename "$0")" in
  pi-agent.sh) echo "note: pi-agent.sh is deprecated (renamed s2-agent, 2026-08-21); use ./s2-agent.sh" >&2 ;;
esac

# Resolve symlinks so this script works through a symlink (e.g. the repo-root
# ./s2-agent.sh → bun-apps/s2-agent/run.sh convenience launcher). Without this,
# BASH_SOURCE[0] is the symlink path and SCRIPT_DIR lands at the link's dir
# (repo root), where src/cli.ts does not exist → false "no entry"
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

    ./bun-apps/s2-agent/update-pi.sh            # upgrade all 4 to latest
    ./bun-apps/s2-agent/update-pi.sh --check    # current vs latest only
    ./bun-apps/s2-agent/update-pi.sh --rebuild  # also cut a new versioned deploy
    ./bun-apps/s2-agent/update-pi.sh --help     # full wrapper docs

  The wrapper rewrites the exact version pins for all 4 packages across
  every bun-apps/*/package.json in one pass (they're published in lockstep
  by the same upstream vendor, and `bun update --latest` cannot fix
  sub-workspace exact pins — the wrapper's perl pin-edit can), reconciles
  bun.lock, and verifies each installed version.

  Verify after:  ./s2-agent.sh --list-models

Notes:
  - These 4 packages are workspace deps pinned to exact versions (no "latest"/
    "*"/range in dependencies/devDependencies) — drift only happens via this
    wrapper now, not automatically on every upstream publish.
  - NEVER use `npm install`; it writes the gitignored package-lock.json.
  - This launcher is also reachable via the repo-root symlink ./s2-agent.sh.
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
# This launcher runs s2-agent FROM THE REPO. The deployed artifact is a
# self-contained binary with its own run.sh (the s2-agent-sh tree), so it never
# reaches this file.
#
# There used to be a `s2-agent.js` arm ahead of this one, for the bundle deploy.
# Its producer (scripts/deploy.ts) was retired in #1740 and the runtime that
# resolved that layout went in Phase 1b, so the arm could only ever have matched
# a stale artifact left over from before either — and would then have run it
# with a runtime that no longer understands it.
if [ -f "$SCRIPT_DIR/src/cli.ts" ]; then
  ENTRY="$SCRIPT_DIR/src/cli.ts"
  MODE="source (dev)"
else
  echo "error: no s2-agent entry found in $SCRIPT_DIR" >&2
  echo "       expected src/cli.ts — this launcher runs s2-agent from the repo;" >&2
  echo "       a deployed tree has its own run.sh beside its binary" >&2
  exit 1
fi

if [ "${PIAGENT_DEBUG:-0}" = "1" ]; then
  echo "[run.sh] mode=$MODE  entry=$ENTRY  cwd=$(pwd)" >&2
fi

# Source-mode pre-flight dep self-heal: ensure extension workspace deps are
# linked into node_modules BEFORE bun boots. The bun process that loads the
# extensions imports them as bare specifiers (@repo/…, js-yaml,
# @mozilla/readability, …); under Bun's isolated linker those only resolve once
# `bun install` has run. Installing here (in a throwaway process) means the
# subsequent `exec bun` is FRESH and sees the deps on the FIRST launch —
# resolve.ts's mid-boot auto-install can't satisfy the same launch (Bun doesn't
# re-scan node_modules mid-process), which is why ./s2-agent.sh needed a manual
# `bun install` + re-run. check-deps.ts is a silent no-op when nothing's
# missing. Gated to source mode (deploys bake deps in). Opt out with
# BUN_PI_AUTO_INSTALL=0 (passed through to check-deps.ts). `|| true` so a failed
# install still launches pi, which then prints the actionable guide.
if [ -f "$SCRIPT_DIR/src/cli.ts" ] && [ -f "$SCRIPT_DIR/src/run-dir/check-deps.ts" ]; then
  bun "$SCRIPT_DIR/src/run-dir/check-deps.ts" || true
fi

# Source-mode layout self-heal (AFTER check-deps so the store target exists):
# this monorepo keeps the Bun workspace at bun-apps/ below the git root, so pi
# boots from a repo-root cwd that has no node_modules. Bun treats the git root
# as the run's project root and, on every launch, materializes a workspace-link
# farm into <git-root>/node_modules (junk: pure symlinks into the global store,
# re-created after every `git clean -dxf`). Pinning a symlink to the REAL
# workspace store satisfies Bun's resolution, so the farm is never built.
# Skipped when the git root IS the workspace root (single-workspace-at-top
# repos, deployed layouts) or when the store target is absent (deps broken
# anyway).
#
# RECLAIM (added after this self-heal was found to be inert in practice): the
# original guard was create-if-missing only. A repo that ALREADY had a real farm
# directory sitting at the git root — the exact state this code exists to
# prevent — could therefore never be healed: the guard saw something there and
# declined forever, while Bun kept re-materializing into it on every launch. So
# a real directory is now reclaimed first, but ONLY when it is provably nothing
# but a link farm: zero regular files anywhere beneath it. A farm is pure
# symlinks-into-the-global-store plus the directories holding them, so that test
# passes for junk and fails for anything with real content (a genuine install
# has package.json / .js files). If any regular file exists we leave the whole
# thing alone rather than guess — deleting a user's real tree is far worse than
# leaving the farm.
if [ -f "$SCRIPT_DIR/src/cli.ts" ] && command -v git >/dev/null 2>&1; then
  REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
  WORKSPACE_ROOT="$(cd -P "$SCRIPT_DIR/.." && pwd)"
  # Derived, not hardcoded to "bun-apps": the link is relative to the git root,
  # so it must name whatever the workspace dir is actually called.
  WORKSPACE_NAME="$(basename "$WORKSPACE_ROOT")"
  if [ -n "$REPO_ROOT" ] && [ "$REPO_ROOT" != "$WORKSPACE_ROOT" ] \
      && [ -d "$WORKSPACE_ROOT/node_modules" ]; then
    ROOT_NM="$REPO_ROOT/node_modules"
    if [ -d "$ROOT_NM" ] && [ ! -L "$ROOT_NM" ] \
        && [ -z "$(find "$ROOT_NM" -type f -print -quit 2>/dev/null)" ]; then
      rm -rf "$ROOT_NM"
      if [ "${PIAGENT_DEBUG:-0}" = "1" ]; then
        echo "[run.sh] reclaimed $ROOT_NM (Bun link farm, no regular files)" >&2
      fi
    fi
    # `-e` alone is false for a DANGLING symlink, which would then make `ln -s`
    # fail with "File exists"; `-L` covers that case.
    if [ ! -e "$ROOT_NM" ] && [ ! -L "$ROOT_NM" ]; then
      ln -s "$WORKSPACE_NAME/node_modules" "$ROOT_NM"
    fi
  fi
fi

exec bun "$ENTRY" "$@"
