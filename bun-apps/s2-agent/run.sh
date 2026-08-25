#!/usr/bin/env bash
########################################
# run.sh — the launcher for s2-agent FROM THE REPO, runnable from any cwd.
#
# s2-agent = renamed pi-agent (2026-08-21); upstream deps stay
# @earendil-works/pi-*; the repo-root ./pi-agent.sh remains a deprecated
# compat alias → ./s2-agent.sh → here. Entry is src/cli.ts (source mode,
# additive with .pi/ + ~/.pi/). The deployed s2-agent-sh tree ships its own
# run.sh beside a self-contained binary and never reaches this file. (A
# second auto-detected layout — a deployed `s2-agent.js` — was retired with
# its producer in #1740 / Phase 1b.)
#
# USAGE
#   ./run.sh                            # interactive TUI
#   ./run.sh -p "hello"                 # print mode
#   ./run.sh --list-models
#   ./run.sh -e path/to/ext.ts -p "…"   # any pi flag, forwarded untouched
#   PIAGENT_DEBUG=1 ./run.sh …          # print which entry/mode was chosen
#   cd /anywhere && /abs/path/to/.../run.sh -p hi   # resolves its own dir
#
# UPGRADING pi: pi's built-in `pi update` is DISABLED here — the 4
# @earendil-works/pi-* packages are workspace deps pinned to exact versions,
# published in lockstep. Use the dedicated wrapper, directly or via this
# launcher's thin passthrough:
#   ./run.sh --upgrade [--check|--rebuild]   # = ./bun-apps/s2-agent/update-pi.sh
# It rewrites the exact pins across every bun-apps/*/package.json in one pass
# (`bun update --latest` cannot fix sub-workspace exact pins), reconciles
# bun.lock, and verifies versions — full procedure: `update-pi.sh --help`.
# NEVER `npm install` (writes the gitignored package-lock.json). Editing
# run.sh updates both invocations (./s2-agent.sh symlinks here).
########################################
set -euo pipefail

# Deprecated-name notice: invoked through the repo-root compat symlink
# ./pi-agent.sh → ./s2-agent.sh → here. stderr-only, non-fatal.
case "$(basename "$0")" in
  pi-agent.sh) echo "note: pi-agent.sh is deprecated (renamed s2-agent, 2026-08-21); use ./s2-agent.sh" >&2 ;;
esac

# Resolve symlinks so this script works through a symlink (the repo-root
# ./s2-agent.sh → here). Without it SCRIPT_DIR lands at the link's dir (repo
# root), where src/cli.ts does not exist → false "no entry" error. Portable
# while-loop (no `readlink -f` — not available on older macOS).
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

# `--upgrade`/`-U` is a thin passthrough to the dedicated wrapper — upgrade
# logic stays in ONE place (update-pi.sh), never duplicated here. Trailing
# flags (--check/--rebuild/--help) forward as-is; `--help` is where the old
# --update-help flag's guidance lives now (removed round-2 ticket 08).
if [ "${1:-}" = "--upgrade" ] || [ "${1:-}" = "-U" ]; then
  shift
  exec "$SCRIPT_DIR/update-pi.sh" "$@"
fi

# This launcher runs s2-agent FROM THE REPO; the deployed tree ships its own
# run.sh beside its binary, so exactly one entry arm remains.
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

# Source-mode pre-flight dep self-heal: link extension workspace deps into
# node_modules BEFORE bun boots. The bun process that loads extensions
# imports them as bare specifiers (@repo/…, js-yaml, …); under Bun's isolated
# linker those resolve only after `bun install` has run, and resolve.ts's
# mid-boot auto-install can't satisfy the SAME launch (Bun never re-scans
# node_modules mid-process). Running it here in a throwaway process means the
# `exec bun` below is FRESH and sees deps on FIRST launch. check-deps.ts is a
# silent no-op when nothing's missing; opt out with BUN_PI_AUTO_INSTALL=0.
# `|| true` so a failed install still launches pi, which then prints the
# actionable guide.
if [ -f "$SCRIPT_DIR/src/cli.ts" ] && [ -f "$SCRIPT_DIR/src/run-dir/check-deps.ts" ]; then
  bun "$SCRIPT_DIR/src/run-dir/check-deps.ts" || true
fi

# Source-mode layout self-heal (AFTER check-deps so the store target exists):
# the Bun workspace sits at bun-apps/ below the git root, so a repo-root cwd
# has no node_modules and Bun materializes a junk workspace-link farm into
# <git-root>/node_modules on every launch (pure symlinks into the global
# store, re-created after every `git clean -dxf`). Pinning a symlink to the
# REAL workspace store satisfies Bun's resolution, so the farm is never
# built. An EXISTING real directory at the git root is reclaimed first — but
# ONLY when provably nothing but a link farm: ZERO regular files anywhere
# beneath it (a farm is symlinks + their dirs; a genuine install has
# package.json / .js files). If ANY regular file exists we leave the whole
# thing alone rather than guess — deleting a user's real tree is far worse
# than leaving the farm.
if [ -f "$SCRIPT_DIR/src/cli.ts" ] && command -v git >/dev/null 2>&1; then
  REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
  WORKSPACE_ROOT="$(cd -P "$SCRIPT_DIR/.." && pwd)"
  # Derived, not hardcoded to "bun-apps": the link is relative to the git
  # root, so it must name whatever the workspace dir is actually called.
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
