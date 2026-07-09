#!/usr/bin/env bash
# test-portability-audit.sh — mechanical, reproducible scan for the four
# "works on my machine" test-portability failure classes.
#
# Background: CI (#381) went red on its first ubuntu-latest run, exposing 4
# latent bugs that local `bun test` had masked (the dev machine is fully set
# up: Apple Silicon, MLX venv, built swift binaries, ffmpeg, a real vault
# submodule). Each was a "works on my machine" failure. This script greps the
# test surface for the four signal patterns so the class can be audited
# PROACTIVELY (not one red CI run at a time) and so a prevention gate can block
# NEW ungated machine-coupled tests from landing.
#
# The four classes (each cheap to grep; fix patterns proven in #381):
#   P1  existsSync of a machine-coupled path
#       (python/venv, swift/, run.py, mlx-models, video_generation__models)
#   P2  Bun.spawn / spawnSync / execSync of a non-bun binary (host-binary probe)
#   P3  process.env.<PROVIDER>_API_KEY / _TOKEN reads (env-isolation risk)
#   P4  process.env.OB_VAULT_* reads (stale / mid-async env-read risk)
#
# For each hit the script classifies the file as GUARDED (uses a CI/env guard
# or an injection seam — the proven #381 patterns) or UNGATED (no guard signal
# — a potential portability bug, or a file needing a guard added).
#
# Guard signals (any present in the file ⇒ GUARDED):
#   - process.env.CI  /  .skipIf(            — CI-skip guard
#   - MLX_E2E | PI_AGENT_E2E | PI_RUN_L2 | PI_AGENT_E2E_IMAGE |
#     PI_AGENT_E2E_DEPLOY | PI_SKIP_L2       — env-var opt-in gate
#   - CONFIG_PRESENT | testWithoutEnv        — testWithoutEnv in-body-clear pattern
#   - __setVaultResolverForTest              — deterministic injection seam
#
# Usage (from repo root):
#   bash scripts/test-portability-audit.sh            # report (exit 0; warn-only)
#   bash scripts/test-portability-audit.sh --strict   # exit 1 on any UNGATED P1/P2 hit
#
# --strict targets P1/P2 only — those are reliably detectable (an existsSync of
# python/venv or a Bun.spawn in a test is almost always machine-coupled). P3/P4
# are reported for REVIEW but never block: env-isolation and mid-async-read
# flaws need structural analysis (does a beforeEach set X while a sibling test
# asserts X unset without an in-body clear?) that a line-grep can't do without
# prohibitive false positives. The catalog (.github/TEST-PORTABILITY.md) is the
# human-reviewed disposition for P3/P4; this script is the mechanical baseline.
#
# CI rollout: v1 runs WARN-ONLY (no --strict) as a regression-gates step, so the
# report is visible on every PR without blocking. Flip to --strict once the
# false-positive rate is confirmed ≈ 0 across a few PRs (the documented capstone).
set -uo pipefail

STRICT=0
[ "${1:-}" = "--strict" ] && STRICT=1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Test surface: *.test.ts / *.test.mjs under bun-apps/, excluding node_modules
# and compiled dist/ (which can contain stale test artifacts). grep --include /
# --exclude-dir let us scan without buffering a file list (portable to bash 3.2,
# which macOS ships — no mapfile/readarray until bash 4).
GREP_FILTERS=(--include='*.test.ts' --include='*.test.mjs' --exclude-dir=node_modules --exclude-dir=dist)
TOTAL_FILES="$(
	find bun-apps -type f \( -name '*.test.ts' -o -name '*.test.mjs' \) \
		-not -path '*/node_modules/*' -not -path '*/dist/*' | wc -l | tr -d ' '
)"

# guard_signals regex — if a file matches ANY of these it is GUARDED.
GUARD_RE='process\.env\.CI|\.skipIf\(|MLX_E2E|PI_AGENT_E2E|PI_RUN_L2|PI_AGENT_E2E_IMAGE|PI_AGENT_E2E_DEPLOY|PI_SKIP_L2|CONFIG_PRESENT|testWithoutEnv|__setVaultResolverForTest'

# Pattern regexes.
P1_RE='existsSync\s*\([^)]*(python/venv|swift/|run\.py|mlx-models|video_generation__models)'
P2_RE='Bun\.spawn|spawnSync|execSync'
P3_RE='process\.env\.[A-Z][A-Z0-9_]*_(API_KEY|TOKEN)'
P4_RE='process\.env\.OB_VAULT'

# Counters.
p1_guarded=0; p1_ungated=0
p2_guarded=0; p2_ungated=0
p3_guarded=0; p3_ungated=0
p4_guarded=0; p4_ungated=0
block_files=""   # P1/P2 UNGATED files (the --strict failures)

emit() { printf '%s\n' "$*"; }

scan_pattern() {
	# $1 = pattern name (P1..P4), $2 = regex, $3 = blocks-under-strict (1/0)
	local name="$1" re="$2" blocks="$3"
	local hits guarded_hits ungated_hits
	hits="$(grep -rEn "$re" "${GREP_FILTERS[@]}" bun-apps 2>/dev/null || true)"
	[ -z "$hits" ] && { emit "  $name: 0 hits"; return; }
	guarded_hits=""; ungated_hits=""
	while IFS= read -r line; do
		[ -z "$line" ] && continue
		local file="${line%%:*}"
		if grep -Eq "$GUARD_RE" "$file" 2>/dev/null; then
			guarded_hits="${guarded_hits}${line}"$'\n'
		else
			ungated_hits="${ungated_hits}${line}"$'\n'
			if [ "$blocks" = "1" ]; then
				case "$block_files" in
					*"$file"*) ;;  # already recorded
					*) block_files="${block_files}${file}"$'\n' ;;
				esac
			fi
		fi
	done <<<"$hits"
	local g u
	g="$(printf '%s' "$guarded_hits" | grep -c . || true)"
	u="$(printf '%s' "$ungated_hits" | grep -c . || true)"
	emit "  $name: ${g} GUARDED, ${u} UNGATED"
	[ "$g" -gt 0 ] && { emit "    [GUARDED]:"; printf '%s\n' "$guarded_hits" | sed 's/^/      /' | grep .; }
	if [ "$u" -gt 0 ]; then
		if [ "$blocks" = "1" ]; then
			emit "    [BLOCK under --strict] UNGATED hits:"
		else
			emit "    [REVIEW] UNGATED hits (informational, never blocks):"
		fi
		printf '%s\n' "$ungated_hits" | sed 's/^/      /' | grep .
	fi
}

emit "═══ test-portability audit ═══"
emit "scanned $TOTAL_FILES test files under bun-apps/ (excluding node_modules, dist)"
emit ""
emit "patterns (P1/P2 block under --strict; P3/P4 are review-only):"
scan_pattern "P1  existsSync(machine-coupled path)" "$P1_RE" 1
scan_pattern "P2  spawn/exec (host-binary probe)"    "$P2_RE" 1
scan_pattern "P3  process.env.*_API_KEY/_TOKEN"      "$P3_RE" 0
scan_pattern "P4  process.env.OB_VAULT_*"            "$P4_RE" 0
emit ""

# --strict: fail on any UNGATED P1/P2 hit (the reliably-detectable classes).
if [ "$STRICT" = "1" ]; then
	if [ -n "$block_files" ]; then
		emit "✗ --strict: UNGATED P1/P2 hits in:"
		printf '%s\n' "$block_files" | sed 's/^/  /' | grep .
		emit ""
		emit "Fix: wrap the machine-coupled test in *.skipIf(process.env.CI), or gate it"
		emit "behind an env-var opt-in (MLX_E2E / PI_AGENT_E2E / PI_RUN_L2). See"
		emit ".github/TEST-PORTABILITY.md for the four failure classes + fix patterns."
		exit 1
	fi
	emit "✓ --strict: no UNGATED P1/P2 hits (all machine-coupled probes are guarded)"
	exit 0
fi

emit "warn-only mode (CI v1). Re-run with --strict to block on UNGATED P1/P2 hits."
emit "Full disposition of every hit: .github/TEST-PORTABILITY.md"
exit 0
