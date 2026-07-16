#!/usr/bin/env bash
# ci-changed-packages.sh — decides which bun-apps/* packages CI's `tests` matrix
# needs to actually run, based on which files changed.
#
# Every bun-apps/<pkg>/package.json's @repo/* dependencies are read LIVE (grep,
# not a hand-maintained table) so this never goes stale the way a hardcoded
# dependency map would the day someone adds a new workspace import — the exact
# class of drift this session spent its whole review methodology hunting down
# (see the @earendil-works/pi-tui 0.80.6/0.80.7 lockfile incident and the
# power-tool cli-subcommand.ts stale-tool-list fix). A package's affected-set is
# itself plus every package that transitively depends on it (reverse-BFS over
# the @repo/* graph): if bun-apps/pi-agent-ext-file2md/ changes, pi-agent-ext-flux2
# (direct dep) AND pi-agent-ext-movie-director (depends on flux2) both need to
# re-run, not just file2md itself.
#
# Fails OPEN, not closed: any change outside bun-apps/<pkg>/ (root config,
# .github/, scripts/, submodules, etc.) marks every package true, since a
# shared-config change could affect any of them and this script has no way to
# know which. --all does the same unconditionally (used for push-to-main, same
# precedent as ci.yml's check-deploy-paths "push always runs everything").
#
# bash 3.2 compatible on purpose (macOS ships no newer bash and this repo has
# no homebrew-bash dependency elsewhere) — indexed arrays only, no `declare -A`.
#
# USAGE:
#   bash scripts/ci-changed-packages.sh --all
#   bash scripts/ci-changed-packages.sh <base-ref> <head-ref>
#
# OUTPUT: a single-line JSON object on stdout, one boolean per bun-apps/*
# package that has a package.json, e.g. {"pi-agent":true,"pi-agent-cli":true,...}
set -euo pipefail

# Resolve from CWD (git toplevel), not the script's own location — so this
# behaves correctly both for real CI use (cwd = repo root via actions/checkout)
# AND for tests that point it at a synthetic tmp repo.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$REPO_ROOT" ]]; then
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
EXTS_DIR="$REPO_ROOT/bun-apps"

# --- 0. Parse args --------------------------------------------------------
ALL_MODE=false
BASE_REF=""
HEAD_REF=""
if [[ "${1:-}" == "--all" ]]; then
  ALL_MODE=true
else
  BASE_REF="${1:?usage: ci-changed-packages.sh --all | <base-ref> <head-ref>}"
  HEAD_REF="${2:?usage: ci-changed-packages.sh --all | <base-ref> <head-ref>}"
fi

# --- 1. Discover every package (dir name == matrix `package` value) ------
packages=()
for pkg_json in "$EXTS_DIR"/*/package.json; do
  [[ -f "$pkg_json" ]] || continue
  packages+=("$(basename "$(dirname "$pkg_json")")")
done

# contains <needle> <haystack array elements...> — linear membership test
# (bash 3.2 has no associative arrays, so no O(1) set; these lists are small).
contains() {
  local needle="$1"; shift
  local item
  for item in "$@"; do [[ "$item" == "$needle" ]] && return 0; done
  return 1
}

emit_json() {  # <name:true/false> ...
  local out="{" first=true pair name val
  for pair in "$@"; do
    name="${pair%%:*}"; val="${pair##*:}"
    [[ "$first" == true ]] && first=false || out+=","
    out+="\"$name\":$val"
  done
  out+="}"
  echo "$out"
}

if [[ "$ALL_MODE" == true ]]; then
  pairs=()
  for pkg in "${packages[@]}"; do pairs+=("$pkg:true"); done
  emit_json "${pairs[@]}"
  exit 0
fi

# --- 2. Build the @repo/* dependency table: one line "pkg dep1 dep2 …" ---
# (self-reference stripped — every package.json lists its own @repo/<self>
# as a devDependency/typecheck convention; that's not a real edge.)
DEPS_TABLE=""
for pkg in "${packages[@]}"; do
  pkg_json="$EXTS_DIR/$pkg/package.json"
  raw="$(grep -oE '"@repo/[a-zA-Z0-9_-]+"' "$pkg_json" 2>/dev/null | tr -d '"' | sed 's#^@repo/##' | sort -u || true)"
  line="$pkg"
  for d in $raw; do
    [[ "$d" == "$pkg" ]] && continue
    line="$line $d"
  done
  DEPS_TABLE="$DEPS_TABLE
$line"
done

# direct_dependents <dep> — every package whose direct deps include <dep>.
direct_dependents() {
  echo "$DEPS_TABLE" | awk -v d="$1" '{ for (i=2;i<=NF;i++) if ($i==d) { print $1; break } }'
}

# --- 3. Diff: which files changed between BASE_REF and HEAD_REF ----------
changed_files="$(git -C "$REPO_ROOT" diff --name-only "$BASE_REF" "$HEAD_REF" 2>/dev/null || true)"

# Nothing resolvable (e.g. shallow clone missing the base) → fail open.
if [[ -z "$changed_files" ]] && ! git -C "$REPO_ROOT" rev-parse "$BASE_REF" >/dev/null 2>&1; then
  changed_files="__unresolvable__"
fi

# --- 4. Any change outside bun-apps/<pkg>/ for a KNOWN package → run all ---
run_all=false
directly_touched=()
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  matched=false
  for pkg in "${packages[@]}"; do
    if [[ "$f" == "bun-apps/$pkg/"* ]]; then
      directly_touched+=("$pkg")
      matched=true
      break
    fi
  done
  [[ "$matched" == false ]] && run_all=true
done <<< "$changed_files"

if [[ "$run_all" == true ]]; then
  pairs=()
  for pkg in "${packages[@]}"; do pairs+=("$pkg:true"); done
  emit_json "${pairs[@]}"
  exit 0
fi

# --- 5. Reverse-BFS from directly-touched packages to their dependents ---
# bash 3.2 note: `"${arr[@]}"` on a zero-element array throws "unbound
# variable" under `set -u` (fixed upstream in bash 4.4) — every expansion of a
# possibly-empty array below is guarded with a length check first.
affected=()
queue=()
if [[ ${#directly_touched[@]} -gt 0 ]]; then
  queue=("${directly_touched[@]}")
fi
while [[ ${#queue[@]} -gt 0 ]]; do
  cur="${queue[0]}"
  if [[ ${#queue[@]} -gt 1 ]]; then
    queue=("${queue[@]:1}")
  else
    queue=()
  fi
  already_affected=false
  if [[ ${#affected[@]} -gt 0 ]] && contains "$cur" "${affected[@]}"; then
    already_affected=true
  fi
  [[ "$already_affected" == true ]] && continue
  affected+=("$cur")
  while IFS= read -r dependent; do
    [[ -z "$dependent" ]] && continue
    queue+=("$dependent")
  done <<< "$(direct_dependents "$cur")"
done

# --- 6. Emit JSON covering every known package -----------------------------
pairs=()
for pkg in "${packages[@]}"; do
  is_affected=false
  if [[ ${#affected[@]} -gt 0 ]] && contains "$pkg" "${affected[@]}"; then
    is_affected=true
  fi
  if [[ "$is_affected" == true ]]; then
    pairs+=("$pkg:true")
  else
    pairs+=("$pkg:false")
  fi
done
emit_json "${pairs[@]}"
