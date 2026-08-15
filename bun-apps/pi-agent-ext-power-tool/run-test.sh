#!/usr/bin/env bash
########################################
# run-test.sh — multi-effort-level test launcher for pi-agent-ext-power-tool.
#
# Mirrors bun-apps/pi-agent/run-test.sh's tier names. power-tool has no
# build/deploy step of its own — tiers map onto its L0 (unit) / L2 (opt-in
# real-CLI + real-model) test layers instead (see l2-e2e.test.ts header).
# There is no standalone L1 (deterministic subprocess, no model): invoking a
# tool through the real CLI always calls the configured LLM, so `high` and
# `full` run the same suite and differ only in skip-vs-fail on blocked
# services (PI_REQUIRE_L2).
#
#   quick    (0)   unit only, no typecheck.                              ~1s
#   medium   (1)   + typecheck (tsc --noEmit). DEFAULT.                  ~5s
#   high     (2)   + PI_RUN_L2=1 (blocked services SKIP).                varies
#   readonly (2.5) PI_RUN_L2=1, l2-e2e.test.ts ONLY (skip allowed).      Opt-in tier (not in the stack).
#   full     (3)   quick + medium + PI_RUN_L2=1 PI_REQUIRE_L2=1          varies
#                  (blocked services FAIL, not skip).
#
# USAGE
#   ./run-test.sh                  # = medium
#   ./run-test.sh quick            # pre-commit, no typecheck
#   ./run-test.sh high
#   ./run-test.sh readonly         # l2-e2e.test.ts only, skip allowed
#   ./run-test.sh full             # whole stack, blocked services FAIL
#   ./run-test.sh --effort=medium
#   ./run-test.sh --list           # print the tier table, exit 0
#   ./run-test.sh medium --bail    # extra flags forwarded to `bun test`
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
		quick|medium|high|readonly|full|0|1|2|3) EFFORT="$1"; shift ;;
		*) EXTRA+=("$1"); shift ;;
	esac
done
case "$EFFORT" in
	0) EFFORT="quick" ;; 1) EFFORT="medium" ;; 2) EFFORT="high" ;; 3) EFFORT="full" ;;
esac

print_list() {
	cat <<EOF
$(Y "pi-agent-ext-power-tool run-test.sh — effort tiers"):

  $(G quick)    $(D '~1s')     unit only, no typecheck
  $(G medium)   $(D '~5s')     + typecheck (tsc --noEmit)  $(Y "[default]")
  $(G high)     $(D 'varies')  + PI_RUN_L2=1 (blocked services SKIP)
  $(G readonly) $(D 'varies')  PI_RUN_L2=1, l2-e2e.test.ts ONLY (skip allowed)
  $(G full)     $(D 'varies')  quick + medium + PI_RUN_L2=1 PI_REQUIRE_L2=1 (blocked services FAIL)

Env gates l2-e2e.test.ts reads:
  PI_RUN_L2=1      enable L2 (spawns real CLI + real LM Studio model)  (high+)
  PI_REQUIRE_L2=1  blocked services FAIL instead of SKIP               (full)
  PI_L2_MODEL      override the LM Studio model (default: google/gemma-4-12b)
EOF
}

if [ "$LIST" -eq 1 ]; then print_list; exit 0; fi

case "$EFFORT" in
	quick|medium|high|readonly|full) ;;
	*) echo "$(R "error"): unknown effort '$EFFORT' (want: quick|medium|high|readonly|full)" >&2
	   echo "try: ./run-test.sh --list" >&2; exit 2 ;;
esac

# ── tier runners ──────────────────────────────────────────────────────────
# set -e is OFF here (set -uo pipefail only), so a failing tier reports
# instead of aborting. Do NOT wrap calls in `|| true` — that would reset rc
# to 0 and every tier would report pass even on failure.
OVERALL=0

run_unit() {
	unset PI_RUN_L2 PI_REQUIRE_L2
	( cd "$SCRIPT_DIR" && bun test ${EXTRA[@]+"${EXTRA[@]}"} )
}

run_typecheck() {
	( cd "$SCRIPT_DIR" && bunx tsc --noEmit )
}

run_l2() {
	unset PI_REQUIRE_L2
	export PI_RUN_L2=1
	( cd "$SCRIPT_DIR" && bun test ${EXTRA[@]+"${EXTRA[@]}"} )
}

run_l2_only() {
	unset PI_REQUIRE_L2
	export PI_RUN_L2=1
	( cd "$SCRIPT_DIR" && bun test src/__tests__/l2-e2e.test.ts ${EXTRA[@]+"${EXTRA[@]}"} )
}

run_l2_strict() {
	export PI_RUN_L2=1
	export PI_REQUIRE_L2=1
	( cd "$SCRIPT_DIR" && bun test ${EXTRA[@]+"${EXTRA[@]}"} )
}

# Run a named step, capture rc + elapsed, color the summary line, fold OVERALL.
step() {
	local name="$1"; shift
	local start rc elapsed
	start=$(date +%s)
	"$@" >/tmp/power-tool-runtest.log 2>&1
	rc=$?
	elapsed=$(( $(date +%s) - start ))
	if [ "$rc" -eq 0 ]; then
		echo "$(G '✓') ${name}  $(D "(${elapsed}s)")"
	else
		echo "$(R '✗') ${name}  $(D "(${elapsed}s)")"
		OVERALL=1
	fi
	if [ "$rc" -ne 0 ]; then
		sed 's/^/      /' /tmp/power-tool-runtest.log | tail -n 25 >&2
	fi
}

echo "$(Y "▶ pi-agent-ext-power-tool run-test.sh — effort=$EFFORT")"

case "$EFFORT" in
	quick)
		step "unit (quick)" run_unit
		;;
	medium)
		step "unit (quick)" run_unit
		step "typecheck (medium)" run_typecheck
		;;
	high)
		step "unit (quick)" run_unit
		step "typecheck (medium)" run_typecheck
		step "unit + L2 e2e (high, skip-on-blocked)" run_l2
		;;
	readonly)
		step "L2 e2e only (readonly, skip-on-blocked)" run_l2_only
		;;
	full)
		step "unit (quick)" run_unit
		step "typecheck (medium)" run_typecheck
		step "unit + L2 e2e (full, FAIL-on-blocked)" run_l2_strict
		;;
esac

echo ""
if [ "$OVERALL" -eq 0 ]; then
	echo "$(G "✓ effort=$EFFORT passed")"
else
	echo "$(R "✗ effort=$EFFORT had failures (see above)")"
fi
exit "$OVERALL"
