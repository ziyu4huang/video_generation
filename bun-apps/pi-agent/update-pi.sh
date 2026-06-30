#!/usr/bin/env bash
########################################
# update-pi.sh — upgrade @earendil-works/pi-coding-agent in this workspace
#
# WHY THIS EXISTS
#   pi's built-in `pi update` (self-update) is DISABLED for this repo.
#   pi is installed as a workspace dependency (spec "latest" in every
#   bun-apps/*/package.json), resolved into node_modules/.bun/, NOT in bun's
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

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
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
NEW="$(latest_version || true)"     || die "could not reach npm to fetch latest version."
[[ -n "$NEW" ]] || die "could not fetch latest version of $PKG."

echo "$(dim 'current:') $CUR"
echo "$(dim 'latest :') $NEW"

[[ "$CHECK" -eq 1 ]] && exit 0
[[ "$CUR" == "$NEW" ]] && { echo "$(green 'already up to date.')"; exit 0; }

# Warn (don't fail) on dirty lock/package — the upgrade edits these anyway.
if ! git -C "$REPO_ROOT" diff --quiet -- bun.lock package.json 2>/dev/null; then
  echo "$(yellow 'note:') bun.lock / package.json already have uncommitted changes."
fi

# ── upgrade ──────────────────────────────────────────────────────────────────
echo
echo "$(green '▶') bun update $PKG --latest"
# Spec is the literal tag "latest" in every workspace package.json; --latest
# forces the newest published version and refreshes bun.lock. Tag specs are
# left as "latest" (the script verifies this below).
bun update "$PKG" --latest

# ── verify ───────────────────────────────────────────────────────────────────
AFTER="$(installed_version || true)"
echo
echo "$(dim 'installed after:') ${AFTER:-(unknown)}"
[[ "$AFTER" == "$NEW" ]] || die "version mismatch — expected $NEW, got ${AFTER:-(unknown)}. Inspect bun.lock."
echo "$(green '✓') pi upgraded $CUR → $AFTER"

# Report any package.json specs rewritten away from "latest" (should not happen
# for a tag spec, but surface it if bun changed them).
if rewritten=$(git -C "$REPO_ROOT" diff --name-only -- bun-apps/ 2>/dev/null | grep 'package\.json$'); then
  echo "$(yellow 'note:') package.json specs changed in:"
  echo "$rewritten" | sed 's/^/    /'
  echo "$(dim '    specs still work; to keep the "latest" tag:  git checkout -- bun-apps/*/package.json')"
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
