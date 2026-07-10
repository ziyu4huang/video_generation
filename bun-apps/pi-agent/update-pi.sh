#!/usr/bin/env bash
########################################
# update-pi.sh — upgrade @earendil-works/pi-coding-agent in this workspace
#
# WHY THIS EXISTS
#   pi's built-in `pi update` (self-update) is DISABLED for this repo.
#   pi is installed as a workspace dependency (specs vary across
#   bun-apps/*/package.json: "latest", "*", or ranges like "^0.80.2" / ">=0.74.0"),
#   resolved into node_modules/.bun/, NOT in bun's
#   global store (~/.bun/install/global/node_modules). pi's self-updater only
#   works for global installs, so `pi update` prints
#   "pi cannot self-update this installation." and bails.
#
#   The correct path is a workspace bump via `bun update` at the monorepo
#   root — which is what this script does.
#
# USAGE
#   ./bun-apps/pi-agent/update-pi.sh            # upgrade pi to latest
#   ./bun-apps/pi-agent/update-pi.sh --check    # show current vs latest only
#   ./bun-apps/pi-agent/update-pi.sh --rebuild  # also rebuild pi-agent dist bundle
#   ./bun-apps/pi-agent/update-pi.sh -h|--help  # print this header
#
# Run from anywhere — the script resolves the repo root from its own location.
########################################
set -euo pipefail

# Resolve symlinks so REPO_ROOT is correct even when this script is invoked
# through a symlink (mirrors run.sh's portable loop — no `readlink -f`, which is
# missing on older macOS). Without this, BASH_SOURCE[0] is the link path and
# ../.. lands at the wrong directory.
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PKG="@earendil-works/pi-coding-agent"
# Stable symlink path that reflects the version pi-agent actually loads.
PKG_JSON="$REPO_ROOT/bun-apps/pi-agent/node_modules/$PKG/package.json"

# ── helpers ──────────────────────────────────────────────────────────────────
color() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
green()  { color 32 "$1"; }
yellow() { color 33 "$1"; }
red()    { color 31 "$1"; }
dim()    { color 2  "$1"; }

die() { echo "$(red 'error:') $*" >&2; exit 1; }

installed_version() {
  [[ -f "$PKG_JSON" ]] || return 0
  grep -m1 '"version"' "$PKG_JSON" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'
}

latest_version() {
  bun pm view "$PKG" version 2>/dev/null || npm view "$PKG" version 2>/dev/null
}

cd "$REPO_ROOT"
command -v bun >/dev/null || die "bun not found on PATH."

# ── args ─────────────────────────────────────────────────────────────────────
CHECK=0; REBUILD=0
for a in "$@"; do
  case "$a" in
    --check)   CHECK=1 ;;
    --rebuild) REBUILD=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die "unknown flag: $a (try --help)" ;;
  esac
done

# ── preflight: current vs latest ─────────────────────────────────────────────
CUR="$(installed_version || true)"; CUR="${CUR:-(not installed)}"
# latest_version() falls back bun pm view → npm view; both silenced on failure.
# The trailing `[[ -n ]]` is the real guard — the inner `|| true` would make an
# outer `|| die` dead code, so it is intentionally omitted.
NEW="$(latest_version || true)"
[[ -n "$NEW" ]] || die "could not reach npm to fetch latest version of $PKG."

echo "$(dim 'current:') $CUR"
echo "$(dim 'latest :') $NEW"

[[ "$CHECK" -eq 1 ]] && exit 0
[[ "$CUR" == "$NEW" ]] && { echo "$(green 'already up to date.')"; exit 0; }

# Warn (don't fail) on dirty lock/package — the upgrade edits these anyway.
# Covers root files AND every bun-apps/*/package.json (specs live there too);
# the unquoted glob is shell-expanded to concrete files under `set -e`.
if ! git -C "$REPO_ROOT" diff --quiet -- bun.lock package.json bun-apps/*/package.json 2>/dev/null; then
  echo "$(yellow 'note:') bun.lock / package.json already have uncommitted changes."
fi

# ── upgrade ──────────────────────────────────────────────────────────────────
echo
echo "$(green '▶') bun update $PKG --latest"
# Specs vary across the workspace ("latest", "*", or ranges); --latest forces
# the newest published version regardless of the existing specifier and
# refreshes bun.lock. Tag specs ("latest"/"*") are left untouched; range specs
# (e.g. "^0.80.2") may be bumped — the block below surfaces any such change.
#
# Capture root-package.json state BEFORE the bump (see de-pollute step below).
ROOT_PKG_CLEAN=no
git -C "$REPO_ROOT" diff --quiet -- package.json 2>/dev/null && ROOT_PKG_CLEAN=yes
ROOT_HAD_PI=no
grep -q "\"$PKG\"" "$REPO_ROOT/package.json" 2>/dev/null && ROOT_HAD_PI=yes
bun update "$PKG" --latest

# De-pollute root package.json. KNOWN SIDE EFFECT: `bun update <pkg>` at the
# workspace root ADDS the pkg to root package.json when it was not already a
# root dependency (observed in bun 1.3.14). The root manifest must stay minimal
# (only @types/bun), so when bun spliced $PKG in we revert it and re-run
# `bun install` to reconcile bun.lock — the legitimate per-consumer version
# bumps are preserved. Auto-revert only when root package.json was clean
# before, so pre-existing uncommitted edits (warned about above) are never
# silently destroyed.
if [[ "$ROOT_HAD_PI" == no ]] && grep -q "\"$PKG\"" "$REPO_ROOT/package.json" 2>/dev/null; then
  if [[ "$ROOT_PKG_CLEAN" == yes ]]; then
    echo "$(yellow 'note:') bun added $PKG to root package.json as a side effect — reverting to keep root minimal."
    git -C "$REPO_ROOT" checkout -- package.json
    bun install >/dev/null 2>&1 || die "bun install failed while reconciling bun.lock after the root revert."
  else
    echo "$(yellow 'note:') bun added $PKG to root package.json, but it had pre-existing uncommitted edits — NOT auto-reverting. Review: git diff package.json"
  fi
fi

# ── verify ───────────────────────────────────────────────────────────────────
AFTER="$(installed_version || true)"
echo
echo "$(dim 'installed after:') ${AFTER:-(unknown)}"
[[ "$AFTER" == "$NEW" ]] || die "version mismatch — expected $NEW, got ${AFTER:-(unknown)}. Inspect bun.lock."
echo "$(green '✓') pi upgraded $CUR → $AFTER"

# Surface any package.json spec changes. Range specs (e.g. "^0.80.2") may be
# bumped by --latest; tag specs ("latest"/"*") are left as-is. Report which
# files changed so the user can review the diff.
if rewritten=$(git -C "$REPO_ROOT" diff --name-only -- bun-apps/ 2>/dev/null | grep 'package\.json$'); then
  echo "$(yellow 'note:') package.json specs changed in:"
  echo "$rewritten" | sed 's/^/    /'
  echo "$(dim '    review the spec diff:  git diff bun-apps/')"
fi

# ── optional rebuild ─────────────────────────────────────────────────────────
if [[ "$REBUILD" -eq 1 ]]; then
  echo
  echo "$(green '▶') rebuild pi-agent dist bundle"
  (cd "$REPO_ROOT/bun-apps/pi-agent" && bun scripts/build.ts --all)
fi

# ── next steps ───────────────────────────────────────────────────────────────
echo
echo "$(green 'done.') Next:"
echo "  - restart any running pi session so it loads $AFTER"
echo "  - review the lockfile change:  git diff bun.lock"
[[ "$REBUILD" -eq 1 ]] || echo "  - rebuild the bundle when ready:  $0 --rebuild"
