#!/usr/bin/env bash
# test-determinism-spotcheck.sh — cross-RUN flake detector.
#
# Runs the flake-prone test subset N times in sequence (default 3) and fails if
# any run's pass/fail outcome DIFFERS from the others. A flake = pass-then-fail
# (or fail-then-pass) on identical code, with no changes between runs. This is
# the detection backstop for the determinism contract; the structural audit
# (scripts/test-determinism-audit.sh + .github/TEST-DETERMINISM.md) is the proof.
#
# Scoped to the packages with known determinism smells (the audit's D1/D3
# surface) — see the ENTRIES list below for the current set and why each is in
# it. Keeps CI cost bounded; a full-matrix N× run is a follow-up once the subset
# is clean.
#
# Usage (from repo root):
#   bash scripts/test-determinism-spotcheck.sh            # 3× the flake-prone subset
#   REPEATS=5 bash scripts/test-determinism-spotcheck.sh  # N×
#
# CI rollout: runs as the `determinism spot-check` job. v1 is INFORMATIONAL — a
# detected flake prints [FLAKE] but the job continues (continue-on-error in CI)
# until the false-positive rate is confirmed ≈ 0; flip to blocking once trusted,
# the same discipline as the portability audit. "3× clean is a weak flake
# signal — the structural audit is the proof; this is the detection backstop."
set -uo pipefail

REPEATS="${REPEATS:-3}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

emit() { printf '%s\n' "$*"; }

# Flake-prone subset: "package-dir<TAB>test-command". Commands run from repo
# root (so --cwd / build paths are stable), matching the CI matrix commands.
# - pi-agent-ext-hermes-memory: now pure bun test (Bun-only; the former
#   node:test-hang / tsx carve-out was retired when better-sqlite3/Node support
#   was removed)
# - pi-agent-ext-workflow: build-first; time/runtime fixtures
# - pi-agent-ext-obsidian: mtime/time tests (scoped to the portable extensions suite)
# - pi-agent-ext-archify: one observed non-reproducible failure — the `examples`
#   subcommand rendered 0 of the expected >=5 HTML files in a full-matrix run,
#   then went green 6+ consecutive times on identical code. The test reads the
#   real vendored/examples/ directory before and after the run and asserts a
#   DELTA, so leftover .html from a prior run makes the delta 0 — a cross-RUN
#   coupling exactly of the D3 class this job exists to detect. Under observation
#   rather than diagnosed by guesswork.
#
# This list MUST stay in sync with the `determinism-spotcheck` matrix in
# .github/workflows/ci.yml.disabled — CI passes one package name per matrix job.
# A name here with no matrix row never runs in CI; a matrix row with no entry
# here exits 2 ("unknown package"). bun-apps/tests/ci-workflow-references.test.ts
# asserts the two lists are identical, so the drift cannot go unnoticed.
ENTRIES=(
	"pi-agent-ext-hermes-memory	( cd bun-apps/pi-agent-ext-hermes-memory && bun test )"
	"pi-agent-ext-workflow	( cd bun-apps/pi-agent-ext-workflow && bun run build && bun test )"
	"pi-agent-ext-obsidian	( cd bun-apps/pi-agent-ext-obsidian && bun test extensions/__tests__/ )"
	"pi-agent-ext-archify	( cd bun-apps/pi-agent-ext-archify && bun test --isolate )"
)

FLAKE_DETECTED=0
CONSISTENT_FAIL=0
TAB="$(printf '\t')"   # real tab — ENTRIES separate pkg/cmd with a literal tab

# Optional arg: scope to ONE package. CI runs this script once per matrix
# entry (see .github/workflows/ci.yml `determinism-spotcheck`), so the 3
# packages execute in parallel as separate runner jobs instead of serially
# in one job. Running them on a single shared runner was considered and
# rejected: the workflow entry rebuilds its gitignored dist/, which would
# race with sibling packages that import from it. No arg → run all (local).
if [ -n "${1:-}" ]; then
	filtered=()
	for entry in "${ENTRIES[@]}"; do
		if [ "${entry%%$TAB*}" = "$1" ]; then filtered+=("$entry"); fi
	done
	if [ "${#filtered[@]}" -eq 0 ]; then
		known=""
		for entry in "${ENTRIES[@]}"; do known="${known:+$known }${entry%%$TAB*}"; done
		emit "unknown package '$1'. Known: $known" >&2
		exit 2
	fi
	ENTRIES=("${filtered[@]}")
fi

emit "═══ determinism spot-check ═══"
emit "running the flake-prone subset ${REPEATS}× per package — a differing outcome = a flake"
emit ""

for entry in "${ENTRIES[@]}"; do
	pkg="${entry%%	*}"          # up to first tab
	cmd="${entry#*	}"            # after first tab
	emit "── $pkg ──"
	results=""
	for run in $(seq 1 "$REPEATS"); do
		# Run the package's CI command; capture only the exit code.
		sh -c "$cmd" >/dev/null 2>&1
		ec=$?
		if [ "$ec" = "0" ]; then
			results="${results}PASS "
			emit "  run ${run}: PASS"
		else
			results="${results}FAIL "
			emit "  run ${run}: FAIL (exit $ec)"
		fi
	done
	pass_count=$(printf '%s' "$results" | grep -o 'PASS' | grep -c . || true)
	fail_count=$(printf '%s' "$results" | grep -o 'FAIL' | grep -c . || true)
	if [ "$pass_count" = "$REPEATS" ]; then
		emit "  ✓ $pkg: ${REPEATS}/${REPEATS} clean (no flake)"
	elif [ "$fail_count" = "$REPEATS" ]; then
		emit "  ✗ $pkg: ${REPEATS}/${REPEATS} FAIL — consistent failure (a real bug, NOT a flake)"
		CONSISTENT_FAIL=$((CONSISTENT_FAIL + 1))
	else
		emit "  ⚠ FLAKE in $pkg: mixed outcomes [$results] — pass-then-fail across runs"
		FLAKE_DETECTED=1
	fi
	emit ""
done

emit "═══ verdict ═══"
if [ "$FLAKE_DETECTED" = "1" ]; then
	emit "⚠ flake(s) detected — a test produced differing outcomes across ${REPEATS} runs."
	emit "  This is informational in CI v1 (the job continues). Investigate per-package above;"
	emit "  see .github/TEST-DETERMINISM.md for the four failure classes + fix seams."
elif [ "$CONSISTENT_FAIL" -gt 0 ]; then
	emit "✗ consistent failure(s) — not a flake, a real bug. Fix the failing package(s) above."
else
	emit "✓ no flakes: the flake-prone subset passed ${REPEATS}/${REPEATS} on every package."
fi
# v1 is informational: exit 0 even on a flake (CI uses continue-on-error to
# surface the signal without blocking). Exit non-zero only on a CONSISTENT
# failure (a real bug, never a determinism concern).
[ "$CONSISTENT_FAIL" -gt 0 ] && exit 1
exit 0
