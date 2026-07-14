#!/usr/bin/env bash
########################################
# update-pi.sh — upgrade the @earendil-works/{pi-agent-core,pi-ai,
# pi-coding-agent,pi-tui} package set in this workspace
#
# WHY THIS EXISTS
#   pi's built-in `pi update` (self-update) is DISABLED for this repo.
#   pi is installed as a workspace dependency, resolved into node_modules/
#   via bun's isolated linker + globalStore, NOT bun's global install dir.
#   pi's self-updater only works for global installs, so `pi update` prints
#   "pi cannot self-update this installation." and bails.
#
#   The correct path is a workspace bump via `bun update` at the monorepo
#   root — which is what this script does.
#
#   All 4 packages are published by the same upstream vendor IN LOCKSTEP
#   (confirmed 2026-07-15: all 4 moved 0.80.6→0.80.7 together within one
#   session). Every bun-apps/*/package.json now pins them to an EXACT
#   version (no "latest"/"*"/range) to stop that drift from silently
#   breaking `bun install --frozen-lockfile` in CI — see
#   fix(ci): pin @earendil-works packages to exact versions. That means
#   upgrades no longer happen automatically; this script is the deliberate
#   trigger, and it now updates all 4 together so they never drift apart
#   from each other again.
#
# USAGE
#   ./bun-apps/pi-agent/update-pi.sh            # upgrade all 4 to latest
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

# The 4 lockstep-versioned packages. Order matters only for display.
PKG_NAMES=(pi-agent-core pi-ai pi-coding-agent pi-tui)
FULL_PKGS=()
for n in "${PKG_NAMES[@]}"; do FULL_PKGS+=("@earendil-works/$n"); done

# ── helpers ──────────────────────────────────────────────────────────────────
color() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
green()  { color 32 "$1"; }
yellow() { color 33 "$1"; }
red()    { color 31 "$1"; }
dim()    { color 2  "$1"; }

die() { echo "$(red 'error:') $*" >&2; exit 1; }

# Reads the resolved version(s) for a package straight out of bun.lock —
# robust regardless of WHICH workspace(s) declare it as a direct dependency
# (no single workspace depends on all 4). Prints one version per line; more
# than one line means the pin is inconsistent across workspaces (should not
# happen post-fix, but this is the signal if it does).
lockfile_versions() {
  local pkg="$1"
  grep -oE "\"@earendil-works/${pkg}@[0-9][0-9A-Za-z.+-]*\"" "$REPO_ROOT/bun.lock" 2>/dev/null \
    | sed -E "s/.*@([0-9][0-9A-Za-z.+-]*)\"/\1/" | sort -u
}

latest_version() {
  bun pm view "$1" version 2>/dev/null || npm view "$1" version 2>/dev/null
}

cd "$REPO_ROOT"
command -v bun >/dev/null || die "bun not found on PATH."
[[ -f bun.lock ]] || die "bun.lock not found at repo root — run from a full checkout."

# ── args ─────────────────────────────────────────────────────────────────────
CHECK=0; REBUILD=0
for a in "$@"; do
  case "$a" in
    --check)   CHECK=1 ;;
    --rebuild) REBUILD=1 ;;
    -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
    *) die "unknown flag: $a (try --help)" ;;
  esac
done

# ── preflight: current vs latest, per package ────────────────────────────────
declare -a CUR NEW
ANY_STALE=0
for i in "${!PKG_NAMES[@]}"; do
  n="${PKG_NAMES[$i]}"; full="${FULL_PKGS[$i]}"
  cur_lines="$(lockfile_versions "$n" || true)"
  cur_count=$(echo "$cur_lines" | grep -c . || true)
  if [[ "$cur_count" -gt 1 ]]; then
    echo "$(yellow 'warn:') $full has multiple resolved versions in bun.lock:"
    echo "$cur_lines" | sed 's/^/    /'
  fi
  cur="$(echo "$cur_lines" | tail -1)"; cur="${cur:-(not installed)}"
  new="$(latest_version "$full" || true)"
  [[ -n "$new" ]] || die "could not reach npm to fetch latest version of $full."
  CUR[$i]="$cur"; NEW[$i]="$new"
  marker="$(green '=')"
  [[ "$cur" != "$new" ]] && { marker="$(yellow '<')"; ANY_STALE=1; }
  printf '  %-28s current: %-12s latest: %-12s %s\n' "$full" "$cur" "$new" "$marker"
done

[[ "$CHECK" -eq 1 ]] && exit 0
if [[ "$ANY_STALE" -eq 0 ]]; then
  echo "$(green 'already up to date.') all 4 packages match latest."
  exit 0
fi

# Warn (don't fail) on dirty lock/package — the upgrade edits these anyway.
if ! git -C "$REPO_ROOT" diff --quiet -- bun.lock package.json bun-apps/*/package.json 2>/dev/null; then
  echo "$(yellow 'note:') bun.lock / package.json already have uncommitted changes."
fi

# ── upgrade (all 4 in ONE bun update call, so bun.lock is written once and
#    they can never drift apart from each other again) ──────────────────────
echo
echo "$(green '▶') bun update ${FULL_PKGS[*]} --latest"
# Every package.json now pins these 4 to an EXACT version (no "latest"/"*"/
# range left in dependencies/devDependencies — see the fix this script's
# header references), so --latest bumps the exact pin to the newest
# published version everywhere it's declared.
#
# Capture root-package.json state BEFORE the bump (see de-pollute step below).
ROOT_PKG_CLEAN=no
git -C "$REPO_ROOT" diff --quiet -- package.json 2>/dev/null && ROOT_PKG_CLEAN=yes
ROOT_HAD_ANY=no
for full in "${FULL_PKGS[@]}"; do
  grep -q "\"$full\"" "$REPO_ROOT/package.json" 2>/dev/null && ROOT_HAD_ANY=yes
done
bun update "${FULL_PKGS[@]}" --latest

# De-pollute root package.json. KNOWN SIDE EFFECT: `bun update <pkg>` at the
# workspace root ADDS the pkg to root package.json when it was not already a
# root dependency (observed in bun 1.3.14). The root manifest must stay minimal
# (only @types/bun), so if bun spliced any of the 4 in we revert and re-run
# `bun install` to reconcile bun.lock — legitimate per-consumer version bumps
# are preserved. Auto-revert only when root package.json was clean before, so
# pre-existing uncommitted edits (warned about above) are never silently
# destroyed.
ROOT_HAS_ANY_NOW=no
for full in "${FULL_PKGS[@]}"; do
  grep -q "\"$full\"" "$REPO_ROOT/package.json" 2>/dev/null && ROOT_HAS_ANY_NOW=yes
done
if [[ "$ROOT_HAD_ANY" == no ]] && [[ "$ROOT_HAS_ANY_NOW" == yes ]]; then
  if [[ "$ROOT_PKG_CLEAN" == yes ]]; then
    echo "$(yellow 'note:') bun added one or more of the 4 packages to root package.json as a side effect — reverting to keep root minimal."
    git -C "$REPO_ROOT" checkout -- package.json
    bun install >/dev/null 2>&1 || die "bun install failed while reconciling bun.lock after the root revert."
  else
    echo "$(yellow 'note:') bun added package(s) to root package.json, but it had pre-existing uncommitted edits — NOT auto-reverting. Review: git diff package.json"
  fi
fi

# ── verify ───────────────────────────────────────────────────────────────────
echo
FAILED=0
for i in "${!PKG_NAMES[@]}"; do
  n="${PKG_NAMES[$i]}"; full="${FULL_PKGS[$i]}"
  after_lines="$(lockfile_versions "$n" || true)"
  after="$(echo "$after_lines" | tail -1)"
  after_count=$(echo "$after_lines" | grep -c . || true)
  if [[ "$after_count" -gt 1 ]]; then
    echo "$(red 'error:') $full still has multiple resolved versions after upgrade:"
    echo "$after_lines" | sed 's/^/    /'
    FAILED=1
    continue
  fi
  if [[ "$after" != "${NEW[$i]}" ]]; then
    echo "$(red 'error:') $full version mismatch — expected ${NEW[$i]}, got ${after:-(unknown)}."
    FAILED=1
    continue
  fi
  echo "$(green '✓') $full upgraded ${CUR[$i]} → $after"
done
[[ "$FAILED" -eq 0 ]] || die "one or more packages failed to upgrade cleanly. Inspect bun.lock."

# Surface any package.json spec changes so the user can review the diff.
if rewritten=$(git -C "$REPO_ROOT" diff --name-only -- bun-apps/ 2>/dev/null | grep 'package\.json$'); then
  echo "$(yellow 'note:') package.json changed in:"
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
echo "  - restart any running pi session so it loads the new version"
echo "  - review the lockfile change:  git diff bun.lock"
[[ "$REBUILD" -eq 1 ]] || echo "  - rebuild the bundle when ready:  $0 --rebuild"
