#!/usr/bin/env bash
# ci-local.sh — run the CI `tests` matrix locally, parsed live from the workflow.
#
# WHY THIS EXISTS
#   GitHub Actions is disabled in this repo (.github/workflows/ holds only
#   ci.yml.disabled, and `main` carries no branch-protection rule — see
#   .github/CI.md). The matrix is therefore a SPECIFICATION that nothing
#   executes. This script is the thing that executes it.
#
# THE ONE DESIGN RULE
#   The package/command list is PARSED OUT OF .github/workflows/ci.yml.disabled
#   at runtime. This script deliberately carries NO copy of the matrix. A second
#   hand-maintained copy would drift from the first, and spec-vs-runner drift is
#   the exact failure mode this repo keeps hitting (a stale dist/, a build.ts
#   that never existed, a required check for a deleted package). If you add a
#   matrix row, this script picks it up with no edit here — verify with --list.
#
# WHAT IT COVERS
#   The `tests` job's matrix ONLY — every `- { package: X, test-cmd: Y }` row,
#   run as `Y` inside bun-apps/X with CI=true (the same env var GitHub Actions
#   sets, which is what the machine-coupled tests skip on).
#
# WHAT IT DOES **NOT** COVER — a green run here is NOT a green CI:
#   - extension-contract      (bun test src/__tests__/extension-contract.test.ts)
#   - deploy-verify           (bun-apps/pi-agent/run-test.sh high + readonly)
#   - compile-verify          (bun run deploy:exe + binary smokes)
#   - clean-launch-self-heal  (clean-checkout check-deps.ts self-heal)
#   - regression-gates        (file-size / lockfile-dup / dep-direction / seam /
#                              routing / config-parity / portability /
#                              determinism / pr-finish / schema-cost)
#   - determinism-spotcheck   (3x the flake-prone subset)
#   - the changed_packages smart-routing filter (this script runs EVERYTHING,
#     like push-to-main does, not the affected subset)
#   Nor does it install deps: run `( cd bun-apps && bun install )` first if the
#   tree is fresh.
#
# USAGE
#   bash scripts/ci-local.sh --list             # print the parsed matrix, run nothing
#   bash scripts/ci-local.sh --tsv              # machine-readable "<pkg>\t<cmd>" lines
#   bash scripts/ci-local.sh                    # run every entry, sequentially
#   bash scripts/ci-local.sh --only pi-agent    # run a subset (comma-separated)
#   bash scripts/ci-local.sh --only a,b --list  # preview just that subset
#
#   --tsv exists so OTHER tools can consume the ONE parser rather than growing a
#   second copy of the matrix — bun-apps/tests/ci-workflow-references.test.ts (the
#   guard that every matrix row points at a real package, and every package has a
#   row) reads it. Keep it decoration-free: no colors, no headers, no totals.
#
# BEHAVIOR
#   - Sequential (parallel runs race pi-agent-ext-workflow's shared dist/).
#   - Mirrors `fail-fast: false`: continues past failures, exits 1 if any failed.
#   - A matrix package whose bun-apps/<pkg>/ directory is ABSENT is reported as a
#     loud SKIP (dead row), never a silent pass — that is how pi-agent-ext-picker
#     stayed in the matrix unnoticed. Dead rows do NOT fail the run; they are
#     counted and re-listed in the summary so they get cleaned up.
#
# Runnable from any cwd (paths resolve from the script's own location).
set -uo pipefail

# ── resolve repo root from this script's location (cwd-independent) ──────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

WORKFLOW=".github/workflows/ci.yml.disabled"

LIST_ONLY=0
TSV_ONLY=0
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --list) LIST_ONLY=1; shift ;;
    --tsv) TSV_ONLY=1; shift ;;
    --only) ONLY="${2-}"; [ -n "$ONLY" ] || { echo "--only needs a value"; exit 2; }; shift 2 ;;
    --only=*) ONLY="${1#--only=}"; shift ;;
    -h|--help) sed -n '2,60p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1 (see --help)"; exit 2 ;;
  esac
done

# Color helpers (disabled when stdout isn't a TTY, for clean logs).
if [ -t 1 ]; then
  G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; B=$'\033[34m'; D=$'\033[2m'; X=$'\033[0m'
else
  G=''; Y=''; R=''; B=''; D=''; X=''
fi

step() { echo ""; echo "${B}▶${X} $1 ${D}$2${X}"; }
ok()   { echo "${G}✓${X} $1"; }
warn() { echo "${Y}·${X} $1"; }
fail() { echo "${R}✗${X} $1"; }
die()  { echo "${R}ci-local FAILED: $1${X}" >&2; exit 2; }

[ -f "$WORKFLOW" ] || die "$WORKFLOW not found (repo root: $REPO_ROOT)"

# ── parse the matrix ─────────────────────────────────────────────────────────
# Emits one "<package>\t<test-cmd>" line per `tests` matrix row.
#
# Primary path: a real YAML parse (PyYAML) of jobs.tests.strategy.matrix.include
# — authoritative, and it fails loudly if the job/key is ever restructured.
# Fallback: a line parser over the same include block, for a python3 without
# PyYAML. The fallback is scoped to the `tests` job's include list (it stops at
# the next top-level key) so it can't pick up the determinism-spotcheck matrix,
# and it asserts a non-empty result rather than degrading to "no packages"
# (an empty parse must never read as "everything passed").
parse_matrix() {
  python3 - "$WORKFLOW" <<'PY'
import io, re, sys

path = sys.argv[1]
src = io.open(path, encoding="utf-8").read()

def emit(rows):
    if not rows:
        sys.stderr.write("ci-local: parsed ZERO matrix rows from %s\n" % path)
        sys.exit(3)
    for pkg, cmd in rows:
        sys.stdout.write("%s\t%s\n" % (pkg, cmd))
    sys.exit(0)

# --- primary: real YAML ---
try:
    import yaml
except ImportError:
    yaml = None

if yaml is not None:
    doc = yaml.safe_load(src)
    try:
        include = doc["jobs"]["tests"]["strategy"]["matrix"]["include"]
    except (KeyError, TypeError):
        sys.stderr.write(
            "ci-local: jobs.tests.strategy.matrix.include not found in %s — the "
            "workflow was restructured; update this parser.\n" % path)
        sys.exit(3)
    rows = []
    for entry in include:
        if not isinstance(entry, dict) or "package" not in entry or "test-cmd" not in entry:
            sys.stderr.write("ci-local: unexpected matrix entry: %r\n" % (entry,))
            sys.exit(3)
        rows.append((str(entry["package"]), str(entry["test-cmd"])))
    emit(rows)

# --- fallback: scoped line parse (no PyYAML available) ---
sys.stderr.write("ci-local: PyYAML unavailable — using the fallback line parser\n")
lines = src.splitlines()
start = None
for i, ln in enumerate(lines):
    if re.match(r"^\s{6,}include:\s*$", ln) and any(
        re.match(r"^  tests:\s*$", lines[j]) for j in range(max(0, i - 40), i)
    ):
        start = i + 1
        break
if start is None:
    sys.stderr.write("ci-local: could not locate the tests matrix include block\n")
    sys.exit(3)

rows = []
row_re = re.compile(
    r"^\s*-\s*\{\s*package:\s*([A-Za-z0-9._-]+)\s*,\s*test-cmd:\s*\"(.*)\"\s*\}\s*$")
for ln in lines[start:]:
    if ln.strip() == "" or ln.lstrip().startswith("#"):
        continue
    if not ln.startswith(" " * 10):   # dedented out of the include list
        break
    m = row_re.match(ln)
    if m:
        rows.append((m.group(1), m.group(2)))
emit(rows)
PY
}

MATRIX="$(parse_matrix)" || die "could not parse the tests matrix out of $WORKFLOW"
[ -n "$MATRIX" ] || die "parsed an EMPTY matrix from $WORKFLOW"

# ── --only filter ────────────────────────────────────────────────────────────
if [ -n "$ONLY" ]; then
  FILTERED=""
  IFS=',' read -r -a WANT <<< "$ONLY"
  for w in "${WANT[@]}"; do
    w="$(echo "$w" | tr -d '[:space:]')"
    [ -n "$w" ] || continue
    hit="$(printf '%s\n' "$MATRIX" | awk -F'\t' -v p="$w" '$1==p')"
    [ -n "$hit" ] || die "--only: '$w' is not a package in the $WORKFLOW tests matrix (run --list)"
    FILTERED="${FILTERED}${hit}"$'\n'
  done
  MATRIX="$(printf '%s' "$FILTERED" | sed '/^$/d')"
fi

TOTAL="$(printf '%s\n' "$MATRIX" | wc -l | tr -d ' ')"

# ── --tsv ────────────────────────────────────────────────────────────────────
# The machine-readable face of the SAME parse --list renders for humans. Emitted
# before --list so `--tsv --list` still yields clean TSV.
if [ "$TSV_ONLY" -eq 1 ]; then
  printf '%s\n' "$MATRIX"
  exit 0
fi

# ── --list ───────────────────────────────────────────────────────────────────
# The eyeball check that the parse is correct: every row, its directory status,
# and the exact command that will run. Compare against the workflow by hand once
# after any parser change.
if [ "$LIST_ONLY" -eq 1 ]; then
  echo "${B}ci-local --list${X} ${D}(parsed from $WORKFLOW)${X}"
  echo "${D}$TOTAL matrix entr$( [ "$TOTAL" = "1" ] && echo y || echo ies ); each runs in bun-apps/<package> with CI=true${X}"
  echo ""
  printf '%-3s %-4s %-32s %s\n' "#" "DIR" "PACKAGE" "TEST-CMD"
  printf '%-3s %-4s %-32s %s\n' "---" "----" "--------------------------------" "--------"
  n=0
  while IFS=$'\t' read -r pkg cmd; do
    [ -n "$pkg" ] || continue
    n=$((n+1))
    if [ -d "bun-apps/$pkg" ]; then mark="${G}ok${X}  "; else mark="${R}MISS${X}"; fi
    printf '%-3s %b %-32s %s\n' "$n" "$mark" "$pkg" "$cmd"
  done <<< "$MATRIX"
  echo ""
  echo "${D}Not covered by this script: extension-contract, deploy-verify, compile-verify,${X}"
  echo "${D}clean-launch-self-heal, regression-gates, determinism-spotcheck.${X}"
  exit 0
fi

# ── run ──────────────────────────────────────────────────────────────────────
LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ci-local.XXXXXX")"
PASSED=(); FAILED=(); SKIPPED=()
declare -a TIMINGS=()
RUN_START=$SECONDS

echo "${B}ci-local${X} — CI tests matrix, run locally ${D}($TOTAL entries, sequential, CI=true)${X}"
echo "${D}source: $WORKFLOW · logs: $LOG_DIR${X}"
echo "${Y}NOTE${X} matrix tests only — extension-contract / deploy-verify / compile-verify /"
echo "     regression-gates / determinism-spotcheck are NOT run. Green here != green CI."

IDX=0
while IFS=$'\t' read -r pkg cmd; do
  [ -n "$pkg" ] || continue
  IDX=$((IDX+1))

  if [ ! -d "bun-apps/$pkg" ]; then
    step "[$IDX/$TOTAL] $pkg" "SKIPPED"
    warn "${Y}DEAD MATRIX ROW${X}: bun-apps/$pkg/ does not exist — the workflow lists a"
    echo "  package that isn't in the tree. Not a pass: remove the row from $WORKFLOW"
    echo "  (and from the required-checks list in .github/CI.md)."
    SKIPPED+=("$pkg")
    continue
  fi

  step "[$IDX/$TOTAL] $pkg" "$cmd"
  t0=$SECONDS
  log="$LOG_DIR/$pkg.log"
  ( cd "bun-apps/$pkg" && CI=true bash -c "$cmd" ) >"$log" 2>&1
  rc=$?
  dt=$((SECONDS - t0))
  TIMINGS+=("$pkg	$dt	$rc")

  if [ "$rc" -eq 0 ]; then
    summary="$(grep -aE '^[[:space:]]*[0-9]+ (pass|tests)' "$log" | tail -1 | xargs || true)"
    ok "$pkg ${D}(${dt}s)${X} ${summary:+— $summary}"
    PASSED+=("$pkg")
  else
    fail "$pkg ${D}(${dt}s, exit $rc)${X}"
    echo "${D}--- last 25 lines of $log ---${X}"
    tail -25 "$log" | sed 's/^/  /'
    echo "${D}--- end ---${X}"
    FAILED+=("$pkg")
  fi
done <<< "$MATRIX"

TOTAL_TIME=$((SECONDS - RUN_START))

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
echo "${B}══ summary ══${X} ${D}(${TOTAL_TIME}s total)${X}"
printf '%-32s %8s  %s\n' "PACKAGE" "TIME" "RESULT"
for row in "${TIMINGS[@]}"; do
  IFS=$'\t' read -r p t r <<< "$row"
  if [ "$r" -eq 0 ]; then res="${G}PASS${X}"; else res="${R}FAIL${X} (exit $r)"; fi
  printf '%-32s %7ss  %b\n' "$p" "$t" "$res"
done
for p in "${SKIPPED[@]:-}"; do
  [ -n "$p" ] || continue
  printf '%-32s %8s  %b\n' "$p" "-" "${Y}SKIP${X} (directory missing — dead matrix row)"
done

echo ""
echo "passed: ${#PASSED[@]}   failed: ${#FAILED[@]}   skipped: ${#SKIPPED[@]}   of $TOTAL"

if [ "${#SKIPPED[@]}" -gt 0 ]; then
  echo ""
  echo "${Y}Dead matrix rows (package listed in CI but absent from the tree):${X}"
  for p in "${SKIPPED[@]}"; do echo "  - $p"; done
fi

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo ""
  echo "${R}FAILURES (${#FAILED[@]}):${X}"
  for p in "${FAILED[@]}"; do echo "  - $p   ${D}(log: $LOG_DIR/$p.log)${X}"; done
  echo ""
  echo "${R}ci-local: FAIL${X}"
  exit 1
fi

echo ""
echo "${G}ci-local: PASS${X} ${D}— matrix only; the non-matrix jobs listed above were NOT run.${X}"
exit 0
