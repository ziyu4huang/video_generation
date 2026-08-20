#!/usr/bin/env bash
########################################
# update-pi.sh — upgrade + keep-lockstep the @earendil-works/{pi-agent-core,
# pi-ai, pi-coding-agent, pi-tui} core package set across every workspace.
#
# WHY THIS EXISTS
#   pi's built-in `pi update` (self-update) is DISABLED for this repo.
#   pi is installed as a workspace dependency, resolved into node_modules/
#   via bun's isolated linker + globalStore, NOT bun's global install dir.
#   pi's self-updater only works for global installs, so `pi update` prints
#   "pi cannot self-update this installation." and bails.
#
#   The 4 core packages are the runtime every pi-agent-* extension builds on.
#   They are declared (exact-pinned) across MANY bun-apps/* workspaces — none
#   in root, and no single workspace depends on all 4. They MUST all carry the
#   SAME version everywhere: the upstream vendor publishes them IN LOCKSTEP
#   (confirmed 2026-07-15: all 4 moved 0.80.6→0.80.7 together), and mixing
#   versions across extensions breaks the shared runtime. This script is the
#   single lever that bumps them together and the single guard that verifies
#   they agree.
#
#   The upgrade path edits the exact pin in every declaring package.json
#   directly, then one `bun install` reconciles bun.lock. It deliberately does
#   NOT use `bun update <pkgs> --latest`: in bun 1.3.14 that command, run at
#   the workspace root, fails to bump exact pins inside sub-workspace
#   package.json files (it splices them into root instead), which leaves
#   bun.lock resolving to BOTH old and new versions.
#
# INVARIANT (lockstep)
#   (A) each of the 4 packages is pinned to exactly ONE version across all
#       bun-apps/*/package.json; (B) all 4 share that same version.
#   check_lockstep() enforces both offline. Run before merges / in CI:
#       ./bun-apps/pi-agent/update-pi.sh --lockstep   # offline gate, exits non-zero on drift
#
# USAGE
#   ./bun-apps/pi-agent/update-pi.sh            # upgrade all 4 to latest (unifies any drift)
#   ./bun-apps/pi-agent/update-pi.sh --check    # current vs latest + lockstep report (network)
#   ./bun-apps/pi-agent/update-pi.sh --lockstep # OFFLINE lockstep invariant gate (CI-friendly)
#   ./bun-apps/pi-agent/update-pi.sh --rebuild  # also cut a new versioned deploy (moves `current`)
#   ./bun-apps/pi-agent/update-pi.sh -h|--help  # print this header
#   The upgrade path also runs `bun run typecheck` (mirrors CI: test · pi-agent),
#   exiting non-zero if the new pi core broke a shared type — fix before pushing.
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

# The 4 lockstep-versioned core packages. Order matters only for display.
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

# Source of truth: distinct exact-pinned versions for one package across ALL
# bun-apps/*/package.json. We read pins (not bun.lock) because bun.lock is a
# derived artifact that can transiently hold multiple versions during a broken
# state, while package.json is the authoritative spec humans commit. Prints one
# version per line (sorted, unique); empty if the package isn't declared.
pinned_versions() {
  local pkg="$1"
  grep -rhoE "\"@earendil-works/${pkg}\": \"[^\"]+\"" \
    "$REPO_ROOT"/bun-apps/*/package.json 2>/dev/null \
    | sed -E "s/.*: \"([^\"]+)\"/\1/" | sort -u
}

# Derived: distinct resolved versions for a package in bun.lock. More than one
# line means the lockfile is stale/corrupt and needs `bun install` to reconcile
# (a symptom, not the source of truth).
lockfile_versions() {
  local pkg="$1"
  grep -oE "\"@earendil-works/${pkg}@[0-9][0-9A-Za-z.+-]*\"" "$REPO_ROOT/bun-apps/bun.lock" 2>/dev/null \
    | sed -E "s/.*@([0-9][0-9A-Za-z.+-]*)\"/\1/" | sort -u
}

latest_version() {
  bun pm view "$1" version 2>/dev/null || npm view "$1" version 2>/dev/null
}

# LOCKSTEP invariant gate. Verifies (A) each of the 4 packages is pinned to a
# single version across all workspaces, and (B) all 4 share that version.
# Sets globals: LOCKSTEP_OK (1/0), LOCKSTEP_VER (uniform version when OK),
# LOCKSTEP_DRIFT (human-readable detail when not OK). Prints a one-line verdict
# + detail. Returns 0 iff the invariant holds. Network-free.
LOCKSTEP_OK=0; LOCKSTEP_VER=""; LOCKSTEP_DRIFT=""
check_lockstep() {
  LOCKSTEP_OK=1; LOCKSTEP_VER=""; LOCKSTEP_DRIFT=""
  local all_versions="" n full pins pcount
  for n in "${PKG_NAMES[@]}"; do
    full="@earendil-works/$n"
    pins="$(pinned_versions "$n" || true)"
    pcount=$(printf '%s\n' "$pins" | grep -c . || true)
    if [[ "$pcount" -gt 1 ]]; then
      LOCKSTEP_OK=0
      LOCKSTEP_DRIFT+="${full} is pinned to ${pcount} different versions across workspaces:"$'\n'
      LOCKSTEP_DRIFT+="$(printf '      %s\n' $pins)"$'\n'
    elif [[ "$pcount" -eq 1 ]]; then
      all_versions+="${pins}"$'\n'
    fi
  done
  # (B) cross-package: every declared version must be identical (upstream lockstep)
  local uniq_all ucount
  uniq_all="$(printf '%s' "$all_versions" | sort -u)"
  ucount=$(printf '%s\n' "$uniq_all" | grep -c . || true)
  if [[ "$ucount" -gt 1 ]]; then
    LOCKSTEP_OK=0
    LOCKSTEP_DRIFT+="the 4 core packages disagree on version (not lockstep):"$'\n'
    LOCKSTEP_DRIFT+="$(printf '      %s\n' $uniq_all)"
  fi
  if [[ "$LOCKSTEP_OK" -eq 1 ]]; then
    LOCKSTEP_VER="${uniq_all}"
    echo "$(green '✓') lockstep OK — every pi-agent-* workspace pins all 4 core packages at ${LOCKSTEP_VER}."
  else
    echo "$(red '✗') lockstep BROKEN — pi-agent-* workspaces disagree on pi-* core version:"
    printf '%s\n' "$LOCKSTEP_DRIFT" | sed 's/^/    /'
    echo "    $(dim 'fix: ./bun-apps/pi-agent/update-pi.sh  (unifies all 4 to latest)')"
  fi
  [[ "$LOCKSTEP_OK" -eq 1 ]]
}

# Cut a new pi-agent deploy. Extracted to a function so the early-exit
# "already up to date" path can honor --rebuild too: a prior run may have bumped
# pins + reconciled bun.lock without rebuilding, and --rebuild is an explicit
# request to rebuild regardless of whether versions changed this run.
#
# NOTE: this produces a NEW VERSIONED DEPLOY under ~/proj/dist/pi-agent-sh/ and
# REPOINTS `current` at it — a more consequential action than the old
# dist/pi-agent bundle rebuild it replaces. The four legacy deploy modes were
# retired in the deploy-architecture consolidation, so deploy is the only
# pipeline. Run the CLI directly with --no-current if you want a build that
# does not move `current`.
do_rebuild() {
  echo
  echo "$(green '▶') cut a new pi-agent deploy (versioned; repoints current)"
  (cd "$REPO_ROOT/bun-apps/pi-agent" && bun run deploy --force)
}

# Cross-package TypeScript preflight. Runs `bun run typecheck` (tsc --noEmit)
# from bun-apps/pi-agent — the SAME check CI's `test · pi-agent` job runs — so a
# breaking type change from the new pi core version surfaces LOCALLY before push,
# not 5 minutes into CI. A lockstep bump can change shared interfaces (0.83.0
# added ResourceLoader#getSystemPromptSource / getAppendSystemPromptSources, for
# one); this catches the extension fallout early.
#
# Fatal to the script EXIT, not to the upgrade: pins + bun.lock are already
# correctly bumped and committable as-is, but the source must adapt before
# pushing, so we print the errors and exit non-zero rather than report green.
TYPECHECK_FAILED=0
do_typecheck() {
  echo
  echo "$(green '▶') typecheck (cross-package — mirrors CI: test · pi-agent)"
  local log n
  log="$(mktemp)"
  if (cd "$REPO_ROOT/bun-apps/pi-agent" && bun run typecheck) >"$log" 2>&1; then
    echo "$(green '✓') typecheck clean — no cross-package type errors."
  else
    TYPECHECK_FAILED=1
    n="$(grep -cE 'error TS[0-9]+' "$log" || true)"
    if [[ "$n" -gt 0 ]]; then
      echo "$(red '✗') typecheck FAILED — the new pi core version changed a shared type ($n TS error(s))."
      echo "$(dim '    adapt these call sites before committing:')"
      grep -E 'error TS[0-9]+' "$log" | sed 's/^/      /' | head -40
      [[ "$n" -gt 40 ]] && echo "$(dim "      …($((n - 40)) more — see \`bun run typecheck\`)")"
    else
      echo "$(red '✗') typecheck FAILED (non-TS error — e.g. tsc not resolvable). Last lines:"
      sed 's/^/      /' "$log" | tail -20
    fi
  fi
  rm -f "$log"
}

cd "$REPO_ROOT"
command -v bun >/dev/null || die "bun not found on PATH."
[[ -f bun-apps/bun.lock ]] || die "bun-apps/bun.lock not found — run from a full checkout."

# ── args ─────────────────────────────────────────────────────────────────────
CHECK=0; LOCKSTEP_ONLY=0; REBUILD=0
for a in "$@"; do
  case "$a" in
    --check)    CHECK=1 ;;
    --lockstep) LOCKSTEP_ONLY=1 ;;
    --rebuild)  REBUILD=1 ;;
    -h|--help)  sed -n '2,48p' "$0"; exit 0 ;;
    *) die "unknown flag: $a (try --help)" ;;
  esac
done

# ── --lockstep: offline invariant gate only (CI-friendly) ────────────────────
if [[ "$LOCKSTEP_ONLY" -eq 1 ]]; then
  check_lockstep
  [[ "$LOCKSTEP_OK" -eq 1 ]] || exit 1
  # also flag a stale lockfile (pins agree but bun.lock lags) — warning only
  for n in "${PKG_NAMES[@]}"; do
    lcount=$(lockfile_versions "$n" | grep -c . || true)
    [[ "$lcount" -le 1 ]] || echo "$(yellow 'warn:') bun.lock still has multiple @earendil-works/$n versions — run \`bun install\`."
  done
  exit 0
fi

# ── preflight: current (pins) vs latest, per package ─────────────────────────
echo "$(dim '— lockstep invariant —')"
check_lockstep || true
echo
echo "$(dim '— current vs latest —')"
declare -a CUR NEW
ANY_STALE=0
for i in "${!PKG_NAMES[@]}"; do
  n="${PKG_NAMES[$i]}"; full="${FULL_PKGS[$i]}"
  cur_lines="$(pinned_versions "$n" || true)"
  cur_count=$(printf '%s\n' "$cur_lines" | grep -c . || true)
  cur="$(printf '%s\n' "$cur_lines" | tail -1)"; cur="${cur:-(not declared)}"
  new="$(latest_version "$full" || true)"
  [[ -n "$new" ]] || die "could not reach npm to fetch latest version of $full."
  CUR[$i]="$cur"; NEW[$i]="$new"
  marker="$(green '=')"
  { [[ "$cur" == "$new" ]] && [[ "$cur_count" -le 1 ]]; } || { marker="$(yellow '<')"; ANY_STALE=1; }
  printf '  %-32s current: %-12s latest: %-12s %s\n' "$full" "$cur" "$new" "$marker"
done

# Stale lockfile warning (pins are source of truth; lockfile should match).
for i in "${!PKG_NAMES[@]}"; do
  n="${PKG_NAMES[$i]}"; full="${FULL_PKGS[$i]}"
  lcount=$(lockfile_versions "$n" | grep -c . || true)
  [[ "$lcount" -le 1 ]] || echo "$(yellow 'warn:') $full — bun.lock has $lcount resolved versions (needs \`bun install\`)."
done

# --check: report + gate. Exit non-zero iff the lockstep invariant is broken
# (NOT merely because we're behind latest — that's a normal, non-fatal state).
if [[ "$CHECK" -eq 1 ]]; then
  check_lockstep || exit 1
  exit 0
fi

# Determine the single target version (the 4 are lockstep upstream).
NEW_VER="${NEW[0]}"
for i in "${!PKG_NAMES[@]}"; do
  [[ "${NEW[$i]}" == "$NEW_VER" ]] \
    || die "upstream broke lockstep: latest versions differ (${NEW[*]}). Resolve manually — this script refuses to pick one."
done

# Nothing to do if already uniform at latest. Still honor --rebuild: the bump
# may have happened in a prior run (pins + bun.lock already aligned), leaving
# the bundle unrebuilt against the now-installed core.
if [[ "$ANY_STALE" -eq 0 ]] && [[ "$LOCKSTEP_OK" -eq 1 ]] && [[ "$LOCKSTEP_VER" == "$NEW_VER" ]]; then
  echo "$(green 'already up to date.') all 4 packages pinned at $NEW_VER everywhere."
  if [[ "$REBUILD" -eq 1 ]]; then
    do_rebuild
  fi
  exit 0
fi

# Warn (don't fail) on dirty lock/package — the upgrade edits these anyway.
if ! git -C "$REPO_ROOT" diff --quiet -- bun-apps/bun.lock bun-apps/package.json bun-apps/*/package.json 2>/dev/null; then
  echo "$(yellow 'note:') bun-apps/bun.lock / package.json already have uncommitted changes."
fi

# ── upgrade: set all 4 to NEW_VER in every declaring workspace ───────────────
# WHY NOT `bun update <pkgs> --latest`: in bun 1.3.14 that command, run at the
# workspace root, does NOT bump exact pins inside sub-workspace package.json
# files — it splices the pkgs into ROOT package.json (a side effect) and writes
# bun.lock only partially, leaving per-workspace pins at the old version. The
# net result is bun.lock resolving to BOTH old and new versions.
#
# So we set the version directly. We rewrite the version value to NEW_VER on
# every line declaring one of the 4 packages, regardless of its current value
# — that INHERENTLY unifies any drift (the whole point). No OLD_VER needed,
# nothing missed when a dep is the last entry in its block (no trailing comma).
# Package alternation is a fixed literal; only NEW_VER is dynamic (via ENV to
# avoid fragile shell-quoting of the regex).
echo
if [[ "$LOCKSTEP_OK" -eq 1 ]]; then
  echo "$(green '▶') set all 4 core packages → $NEW_VER across bun-apps/*/package.json (was $LOCKSTEP_VER)"
else
  echo "$(green '▶') unify all 4 core packages → $NEW_VER across bun-apps/*/package.json (drift detected, fixing)"
fi
export NEW_VER
bumped=0
for pj in "$REPO_ROOT"/bun-apps/*/package.json; do
  # Skip files that don't declare any of the 4 at all.
  grep -qE '"@earendil-works/(pi-agent-core|pi-ai|pi-coding-agent|pi-tui)":' "$pj" 2>/dev/null || continue
  perl -i -pe '
    s/("\@earendil-works\/(?:pi-agent-core|pi-ai|pi-coding-agent|pi-tui)": ")[^"]*(")/$1$ENV{NEW_VER}$2/;
  ' "$pj" || die "perl pin-set failed for $pj"
  bumped=$((bumped + 1))
done
[[ "$bumped" -gt 0 ]] || die "no bun-apps/*/package.json declares any of the 4 packages — nothing to bump."

bun install --cwd "$REPO_ROOT/bun-apps" >/dev/null 2>&1 \
  || die "bun install failed while reconciling bun-apps/bun.lock after the pin set."

# ── verify: lockstep invariant (hard gate) + per-package resolution ──────────
echo
echo "$(dim '— verify —')"
check_lockstep || die "lockstep invariant still violated after upgrade. Inspect bun-apps/*/package.json."
[[ "$LOCKSTEP_VER" == "$NEW_VER" ]] \
  || die "post-upgrade lockstep version ($LOCKSTEP_VER) != target ($NEW_VER)."

FAILED=0
for i in "${!PKG_NAMES[@]}"; do
  n="${PKG_NAMES[$i]}"; full="${FULL_PKGS[$i]}"
  after_lines="$(lockfile_versions "$n" || true)"
  after="$(printf '%s\n' "$after_lines" | tail -1)"
  after_count=$(printf '%s\n' "$after_lines" | grep -c . || true)
  if [[ "$after_count" -gt 1 ]]; then
    echo "$(red 'error:') $full — bun.lock still has multiple resolved versions:"
    printf '%s\n' "$after_lines" | sed 's/^/    /'
    FAILED=1
    continue
  fi
  if [[ "$after" != "$NEW_VER" ]]; then
    echo "$(red 'error:') $full resolved to ${after:-(unknown)}, expected $NEW_VER."
    FAILED=1
    continue
  fi
  echo "$(green '✓') $full → $after"
done
[[ "$FAILED" -eq 0 ]] || die "one or more packages failed to reconcile in bun.lock."

# Surface any package.json spec changes so the user can review the diff.
if rewritten=$(git -C "$REPO_ROOT" diff --name-only -- bun-apps/ 2>/dev/null | grep 'package\.json$'); then
  echo "$(yellow 'note:') package.json changed in:"
  echo "$rewritten" | sed 's/^/    /'
  echo "$(dim '    review the spec diff:  git diff bun-apps/')"
fi

# ── optional rebuild ─────────────────────────────────────────────────────────
do_typecheck

if [[ "$REBUILD" -eq 1 ]] && [[ "$TYPECHECK_FAILED" -eq 0 ]]; then
  do_rebuild
fi

# ── next steps ───────────────────────────────────────────────────────────────
echo
if [[ "$TYPECHECK_FAILED" -eq 1 ]]; then
  echo "$(yellow 'done — with typecheck errors.') The version bump is applied (pins + bun.lock are"
  echo "committable), but fix the TS errors above before pushing — CI's test · pi-agent gates it."
  [[ "$REBUILD" -eq 1 ]] && echo "$(dim '  (deploy skipped: source did not typecheck)')"
  exit 1
fi
echo "$(green 'done.') Next:"
echo "  - restart any running pi session so it loads the new version"
echo "  - review the lockfile change:  git diff bun-apps/bun.lock"
[[ "$REBUILD" -eq 1 ]] || echo "  - cut a new deploy when ready:  $0 --rebuild"
