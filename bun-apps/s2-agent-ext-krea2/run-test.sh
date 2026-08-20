#!/usr/bin/env bash
########################################
# run-test.sh — tiered test launcher for s2-agent-ext-krea2.
#   quick (default) — this package's existing test command, unchanged.
#   full            — quick + extension-contract.test.ts re-asserted standalone.
# USAGE
#   ./run-test.sh          # quick
#   ./run-test.sh full
#   ./run-test.sh --list
########################################
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

G() { printf '\033[32m%s\033[0m' "$1"; }
R() { printf '\033[31m%s\033[0m' "$1"; }
Y() { printf '\033[33m%s\033[0m' "$1"; }
D() { printf '\033[2m%s\033[0m' "$1"; }

TIER="quick"
LIST=0
EXTRA=()
while [ $# -gt 0 ]; do
	case "$1" in
		-l|--list) LIST=1; shift ;;
		quick|full) TIER="$1"; shift ;;
		*) EXTRA+=("$1"); shift ;;
	esac
done

print_list() {
	cat <<EOF
$(Y "s2-agent-ext-krea2 run-test.sh — tiers"):
  $(G quick)  bun test (this package's existing test command)  $(Y "[default]")
  $(G full)   quick + extension-contract.test.ts re-asserted standalone
EOF
}
if [ "$LIST" -eq 1 ]; then print_list; exit 0; fi
case "$TIER" in quick|full) ;; *) echo "$(R error): unknown tier '$TIER' (want: quick|full)" >&2; exit 2 ;; esac

OVERALL=0
step() {
	local name="$1"; shift
	local start rc elapsed
	start=$(date +%s)
	"$@" >/tmp/s2-agent-ext-krea2-runtest.log 2>&1
	rc=$?
	elapsed=$(( $(date +%s) - start ))
	if [ "$rc" -eq 0 ]; then
		echo "$(G '✓') ${name}  $(D "(${elapsed}s)")"
	else
		echo "$(R '✗') ${name}  $(D "(${elapsed}s)")"
		OVERALL=1
	fi
	if [ "$rc" -ne 0 ]; then sed 's/^/      /' /tmp/s2-agent-ext-krea2-runtest.log | tail -n 25 >&2; fi
}

run_quick() { ( cd "$SCRIPT_DIR" && bun test ${EXTRA[@]+"${EXTRA[@]}"} ) ; }
run_contract() { ( cd "$SCRIPT_DIR" && bun test src/extension-contract.test.ts ) ; }

echo "$(Y "▶ s2-agent-ext-krea2 run-test.sh — tier=$TIER")"
case "$TIER" in
	quick) step "quick" run_quick ;;
	full)  step "quick" run_quick
	       step "contract (standalone)" run_contract ;;
esac

echo ""
if [ "$OVERALL" -eq 0 ]; then echo "$(G "✓ tier=$TIER passed")"; else echo "$(R "✗ tier=$TIER had failures (see above)")"; fi
exit "$OVERALL"
