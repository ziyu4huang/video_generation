#!/usr/bin/env bash
########################################
# run-test.sh — multi-effort-level test launcher for pi-agent-cli.
#
# Effort is a MONOTONIC stack: each level runs everything the lower one does,
# plus more. Cost is driven by the build + deploy, not the tests themselves.
#
#   quick   (0)  unit only (pure fn + import-time smoke). No build.         ~0.3s
#   medium  (1)  + build bundle + bundle e2e (spawns cli.js from a temp cwd  ~6s
#                 and asserts version/help/list-models/list-tools/doctor).
#                 DEFAULT.
#   high    (2)  + compile-exe e2e (bun --compile → standalone binary, same   ~25s
#                 assertions run against the exe).
#   full    (3)  + sibling pi-* unit baseline (whole stack health).          ~30s
#
# USAGE
#   ./run-test.sh                  # = medium
#   ./run-test.sh quick            # pre-commit, no build
#   ./run-test.sh high
#   ./run-test.sh full             # whole stack
#   ./run-test.sh --effort=medium
#   ./run-test.sh --list           # print the tier table, exit 0
#   ./run-test.sh medium --bail    # extra flags forwarded to `bun test`
#
# medium+ force a FRESH build (they do not honor PICLI_E2E_NO_BUILD) so a
# stale dist/ can't mask a bundle regression. Exit code is 0 iff every selected
# tier/package passed.
########################################
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── colors ────────────────────────────────────────────────────────────────
G() { printf '\033[32m%s\033[0m' "$1"; }
R() { printf '\033[31m%s\033[0m' "$1"; }
Y() { printf '\033[33m%s\033[0m' "$1"; }
D() { printf '\033[2m%s\033[0m' "$1"; }

# ── parse args ────────────────────────────────────────────────────────────
EFFORT="medium"
LIST=0
EXTRA=()
while [ $# -gt 0 ]; do
	case "$1" in
		--effort=*) EFFORT="${1#*=}"; shift ;;
		--effort) EFFORT="${2:-}"; shift 2 ;;
		-l|--list) LIST=1; shift ;;
		quick|medium|high|full|0|1|2|3) EFFORT="$1"; shift ;;
		*) EXTRA+=("$1"); shift ;;
	esac
done
# normalize numeric aliases
case "$EFFORT" in
	0) EFFORT="quick" ;; 1) EFFORT="medium" ;; 2) EFFORT="high" ;; 3) EFFORT="full" ;;
esac

print_list() {
	cat <<EOF
$(Y "pi-agent-cli run-test.sh — effort tiers (each ⊇ the one above)"):

  $(G quick)   $(D '~0.3s')  unit only (pure fn + import-time smoke); no build
  $(G medium)  $(D '~6s')    + build + bundle e2e (spawn cli.js from a temp cwd)  $(Y "[default]")
  $(G high)    $(D '~25s')   + compile-exe e2e (standalone binary, same assertions)
  $(G full)    $(D '~30s')   + sibling pi-* unit baseline (whole stack)

Env gates the e2e test file reads:
  PICLI_E2E=1            enable bundle e2e        (medium+)
  PICLI_E2E_COMPILE=1    enable compile-exe e2e   (high+)
  PICLI_E2E_NO_BUILD=1   reuse an existing dist   (ignored at medium+, which forces fresh)
EOF
}

if [ "$LIST" -eq 1 ]; then print_list; exit 0; fi

case "$EFFORT" in
	quick|medium|high|full) ;;
	*) echo "$(R "error"): unknown effort '$EFFORT' (want: quick|medium|high|full)" >&2
	   echo "try: ./run-test.sh --list" >&2; exit 2 ;;
esac

# ── tier runners ──────────────────────────────────────────────────────────
# Each selects env, runs `bun test` (extra flags forwarded), returns its exit
# code. set -e is OFF here so a failing tier reports instead of aborting.
OVERALL=0

run_unit() {
	# quick baseline: e2e auto-skips (no PICLI_E2E).
	unset PICLI_E2E PICLI_E2E_COMPILE
	( cd "$SCRIPT_DIR" && bun test ${EXTRA[@]+"${EXTRA[@]}"} )
}

run_bundle_e2e() {
	unset PICLI_E2E_NO_BUILD      # medium+ forces a fresh build
	export PICLI_E2E=1
	unset PICLI_E2E_COMPILE       # bundle only (no exe tier)
	( cd "$SCRIPT_DIR" && bun test ${EXTRA[@]+"${EXTRA[@]}"} )
}

run_compile_e2e() {
	unset PICLI_E2E_NO_BUILD
	export PICLI_E2E=1
	export PICLI_E2E_COMPILE=1
	( cd "$SCRIPT_DIR" && bun test ${EXTRA[@]+"${EXTRA[@]}"} )
}

# Sibling pi-* suites for the "full" stack-health check. pi-vlm's script wraps
# --isolate (bare `bun test` shows mock-leak false failures); others run plain.
run_pkg_unit() {
	local pkg="$1"
	local d="$SCRIPT_DIR/../$pkg"
	[ -d "$d" ] || { echo "$(Y "· skip $pkg") (dir absent)" >&2; return 0; }
	if [ "$pkg" = "pi-vlm" ]; then
		( cd "$d" && bun run test ${EXTRA[@]+"${EXTRA[@]}"} )
	else
		( cd "$d" && bun test ${EXTRA[@]+"${EXTRA[@]}"} )
	fi
}

# Run a named step, capture rc + elapsed, color the summary line, fold OVERALL.
step() {
	local name="$1"; shift
	local start rc elapsed
	start=$(date +%s)
	# NOTE: set -e is OFF (we use set -uo pipefail only), so a failing "$@" does
	# NOT abort — rc captures the real exit code. Do NOT add `|| true` here: it
	# would reset rc to 0 and every tier would report pass even on failure.
	"$@" >/tmp/pi-cli-runtest.log 2>&1
	rc=$?
	elapsed=$(( $(date +%s) - start ))
	if [ "$rc" -eq 0 ]; then
		echo "$(G '✓') ${name}  $(D "(${elapsed}s)")"
	else
		echo "$(R '✗') ${name}  $(D "(${elapsed}s)")"
		OVERALL=1
	fi
	# Surface the tail of a failed step so the failure isn't hidden.
	if [ "$rc" -ne 0 ]; then
		sed 's/^/      /' /tmp/pi-cli-runtest.log | tail -n 25 >&2
	fi
}

echo "$(Y "▶ pi-agent-cli run-test.sh — effort=$EFFORT")"

case "$EFFORT" in
	quick)
		step "unit (quick)" run_unit
		;;
	medium)
		step "unit + bundle e2e (medium)" run_bundle_e2e
		;;
	high)
		# One bun-test process for unit + bundle + compile e2e so the harness
		# build is shared (both share the cached build promise in e2e-harness).
		step "unit + bundle + compile e2e (high)" run_compile_e2e
		;;
	full)
		step "unit + bundle + compile e2e (high)" run_compile_e2e
		echo "$(Y "▶ sibling stack-health baseline")"
		for pkg in pi-obsidian pi-vlm pi-knowledge-card pi-agent; do
			step "$pkg unit" run_pkg_unit "$pkg"
		done
		;;
esac

echo ""
if [ "$OVERALL" -eq 0 ]; then
	echo "$(G "✓ effort=$EFFORT passed")"
else
	echo "$(R "✗ effort=$EFFORT had failures (see above)")"
fi
exit "$OVERALL"
