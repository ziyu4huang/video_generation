#!/usr/bin/env bash
########################################
# run-test.sh — multi-effort-level test launcher for pi-agent.
#
# Effort is a MONOTONIC stack: each level runs everything the lower one does,
# plus more. Cost is driven by the build + deploy, not the tests themselves.
#
#   quick   (0)  unit only (pure fn + import-time smoke).                  ~0.2s
#   medium  (1)  + the pi-agent package suite, incl. the run.sh/pi-agent.sh   ~7s
#                 launcher e2e (symlink resolution, entry-mode detection,
#                 --update-help, --upgrade passthrough). DEFAULT.
#   smoke    (2)  + LIVE local-LLM check: boots the real launcher in print   ~30s
#                  mode against LM Studio (google/gemma-4-12b on
#                  localhost:1234) — zero cost, zero egress, fully local.
#                  Skips (passes) when LM Studio is down; fails if it's up
#                  but the default model isn't loaded. Opt-in tier; also
#                  folded into full (skips when down).
#   full    (3)  + smoke + sibling pi-* unit baseline (whole stack).        ~40s
#
# The `high` and `readonly` tiers are GONE. They existed to deploy the
# bundle/snapshot/standalone modes and run the e2e suites that asserted against
# them; those modes and suites were retired with the deploy-architecture
# consolidation. The deployed artifact's e2e now lives in
# pi-agent-ext-devops/tests/deploy-sh-probe-e2e.test.ts, gated from CI by
# scripts/check-deploy-sh-e2e.sh.
#
# USAGE
#   ./run-test.sh                  # = medium
#   ./run-test.sh quick            # pre-commit
#   ./run-test.sh smoke            # live check vs local LM Studio only
#   ./run-test.sh full             # whole stack (incl. smoke)
#   ./run-test.sh --effort=medium
#   ./run-test.sh --list           # print the tier table, exit 0
#   ./run-test.sh medium --bail    # extra flags forwarded to `bun test`
#
# Nothing here builds a deploy any more — PI_AGENT_E2E_NO_BUILD is gone with the
# bundle it referred to. Exit code is 0 iff every selected tier/package passed.
########################################
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# This script lives in bun-apps/pi-agent-ext-devops/scripts/, but the package it
# drives is bun-apps/pi-agent — resolve it once here.
PI_AGENT_DIR="$(cd "$SCRIPT_DIR/../../pi-agent" && pwd)"

# ── sibling stack-health baseline (the `full` tier) ───────────────────────
# Sibling bun-apps/<pkg> packages whose suites run as part of `full`. These are
# NAMES, not paths, so nothing typechecks them — this list previously read
# `pi-obsidian pi-knowledge-card`, directories that have never existed, and a
# skip-if-absent branch swallowed the miss for months while reporting green.
#
# `--list-siblings` exists so the list has an EXECUTOR:
# bun-apps/tests/ci-workflow-references.test.ts shells out to it and asserts
# every name resolves to a real bun-apps/<pkg>/package.json. Keep that flag
# working — it is the only thing standing between this list and silent rot.
SIBLING_PKGS=(
	pi-agent-ext-obsidian
	pi-agent-ext-knowledge-card
	pi-agent-ext-file2md
)

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
		# Machine-readable: one sibling package name per line. Consumed by the
		# CI-reference guard test; keep the output one-bare-name-per-line.
		--list-siblings) printf '%s\n' "${SIBLING_PKGS[@]}"; exit 0 ;;
		quick|medium|smoke|full|0|1|2|3) EFFORT="$1"; shift ;;
		*) EXTRA+=("$1"); shift ;;
	esac
done
# normalize numeric aliases
case "$EFFORT" in
	0) EFFORT="quick" ;; 1) EFFORT="medium" ;; 2) EFFORT="smoke" ;; 3) EFFORT="full" ;;
esac

print_list() {
	cat <<EOF
$(Y "pi-agent run-test.sh — effort tiers (each ⊇ the one above)"):

  $(G quick)   $(D '~0.2s')  unit only (pure fn + import-time smoke)
  $(G medium)  $(D '~7s')    + the pi-agent package suite incl. the launcher e2e  $(Y "[default]")
  $(G smoke)   $(D '~30s')   LIVE local-LLM check vs LM Studio (gemma-4-12b, localhost:1234);
                            zero cost/egress. Skips when LM Studio is down, fails if the
                            model isn't loaded. Also folded into $(G full) (skips when down).
  $(G full)    $(D '~40s')   + smoke + sibling pi-* unit baseline (whole stack)

Env gates the e2e test files read:
  PI_AGENT_E2E=1          enable the launcher symlink-resolution block (medium+)

The deployed artifact's own e2e is a separate gate:
  bash scripts/check-deploy-sh-e2e.sh
EOF
}

if [ "$LIST" -eq 1 ]; then print_list; exit 0; fi

case "$EFFORT" in
	quick|medium|smoke|full) ;;
	*) echo "$(R "error"): unknown effort '$EFFORT' (want: quick|medium|smoke|full)" >&2
	   echo "try: ./run-test.sh --list" >&2; exit 2 ;;
esac

# ── tier runners ──────────────────────────────────────────────────────────
# Each selects env, runs `bun test` (extra flags forwarded), returns its exit
# code. set -e is OFF here so a failing tier reports instead of aborting.
OVERALL=0

run_unit() {
	# quick baseline: the one E2E-gated block auto-skips (no PI_AGENT_E2E).
	unset PI_AGENT_E2E
	( cd "$PI_AGENT_DIR" && bun test ${EXTRA[@]+"${EXTRA[@]}"} )
}

run_patches() {
	# Same suite as quick, with PI_AGENT_E2E=1 so the launcher's
	# symlink-resolution block (which spawns the real src/cli.ts) runs too.
	export PI_AGENT_E2E=1
	( cd "$PI_AGENT_DIR" && bun test ${EXTRA[@]+"${EXTRA[@]}"} )
}

# LIVE local-LLM smoke test. Boots the REAL launcher (`run.sh`) in print mode
# against LM Studio (localhost:1234) with the fast default model — zero cost,
# zero egress, fully self-contained. Opt-in tier — run via `./run-test.sh
# smoke`; also folded into `full`. Skips (rc 0) when LM Studio is down (an
# environment condition, not a repo bug); fails with a hint when LM Studio is
# up but the default model isn't loaded. Sets SMOKE_SKIPPED=1 so the caller
# can print the skip notice (step() only surfaces the log on failure).
SMOKE_MODEL="google/gemma-4-12b"
SMOKE_SKIPPED=0
run_smoke() {
	local base="http://localhost:1234/v1" models
	models="$(curl -sf -m 3 "$base/models" 2>/dev/null)" || {
		SMOKE_SKIPPED=1
		return 0
	}
	if ! grep -q "\"$SMOKE_MODEL\"" <<<"$models"; then
		echo "$(R '✗ smoke FAILED') — $SMOKE_MODEL not loaded in LM Studio (load it in My Models first)" >&2
		return 1
	fi
	"$PI_AGENT_DIR/run.sh" --provider lm-studio --model "$SMOKE_MODEL" --no-session -p "hi" >/dev/null 2>&1
}

# step() wrapper: prints the ✓/✗ line via step, then the skip notice to the
# terminal (step captures all output into the log, which is only surfaced on
# failure — a silent skip would read as a pass).
smoke_step() {
	step "live lm-studio smoke (smoke)" run_smoke
	[ "$SMOKE_SKIPPED" -eq 1 ] && echo "$(Y '· smoke skipped') — LM Studio not running on localhost:1234 (start it for the live check)"
}

# Sibling extension suites for the "full" stack-health check.
#
# Always the package's CANONICAL `bun run test` script, never a bare `bun test`:
# each of these encodes a flag the bare form gets wrong (file2md needs --isolate
# or 12 mock-leak false failures appear; obsidian scopes to extensions/__tests__/).
# See CLAUDE.md — "Always run a package's canonical `bun run test` script".
#
# An absent directory is a HARD FAILURE, not a skip. This loop previously named
# `pi-obsidian` / `pi-knowledge-card` — directories that have never existed (the
# real ones are `pi-agent-ext-*`) — and a `return 0` skip swallowed both, so the
# "sibling stack-health baseline" silently tested one package instead of three
# while reporting green. bun-apps/tests/ci-workflow-references.test.ts now pins
# these names; if one moves again, that guard fails before this loop runs.
run_pkg_unit() {
	local pkg="$1"
	local d="$PI_AGENT_DIR/../$pkg"
	if [ ! -d "$d" ]; then
		echo "$(R "✗ $pkg: bun-apps/$pkg/ does not exist")" >&2
		echo "  the sibling list in this script names a package that is gone or renamed." >&2
		return 1
	fi
	( cd "$d" && bun run test ${EXTRA[@]+"${EXTRA[@]}"} )
}

# Run a named step, capture rc + elapsed, color the summary line, fold OVERALL.
step() {
	local name="$1"; shift
	local start rc elapsed
	start=$(date +%s)
	# NOTE: set -e is OFF (we use set -uo pipefail only), so a failing "$@" does
	# NOT abort — rc captures the real exit code. Do NOT add `|| true` here: it
	# would reset rc to 0 and every tier would report pass even on failure.
	"$@" >/tmp/pi-agent-runtest.log 2>&1
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
		sed 's/^/      /' /tmp/pi-agent-runtest.log | tail -n 60 >&2
	fi
}

echo "$(Y "▶ pi-agent run-test.sh — effort=$EFFORT")"

case "$EFFORT" in
	quick)
		step "unit (quick)" run_unit
		;;
	medium)
		step "unit + patch e2e (medium)" run_patches
		;;
	smoke)
		smoke_step
		;;
	full)
		step "unit + patch e2e (medium)" run_patches
		echo "$(Y "▶ live local-LLM smoke (skips when LM Studio is down)")"
		smoke_step
		echo "$(Y "▶ sibling stack-health baseline")"
		for pkg in "${SIBLING_PKGS[@]}"; do
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
