#!/usr/bin/env bash
# test-portability-audit.sh — mechanical, reproducible scan for the five
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
# The five classes (each cheap to grep; fix patterns proven in #381 / #937):
#   P1  existsSync of a machine-coupled path
#       (python/venv, swift/, run.py, mlx-models, video_generation__models)
#   P2  Bun.spawn / spawnSync / execSync of a non-bun binary (host-binary probe)
#   P3  process.env.<PROVIDER>_API_KEY / _TOKEN reads (env-isolation risk)
#   P4  process.env.OB_VAULT_* reads (stale / mid-async env-read risk)
#   P5  real-~/.pi config-loader CALL — loadModelTierConfig() /
#       getModelTierConfigPath() invoked in a test reads the real machine's
#       ~/.pi/workflows/model-tiers.json (the watchdog #937 CI failure class).
#       Call-based (parens); path-injected calls (tmpdir/mkdtemp/cfgPath seam)
#       are GUARDED.
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
#   - process.execPath                       — spawn targets the running runtime
#                                             (bun/node) itself, always present on
#                                             CI; inherently CI-safe (not a host-
#                                             binary probe)
#
# Usage (from repo root):
#   bash scripts/test-portability-audit.sh            # report (exit 0; warn-only)
#   bash scripts/test-portability-audit.sh --strict   # exit 1 on any UNGATED P1/P2 hit
#
# --strict targets P1/P2/P5 only — those are reliably detectable (an existsSync of
# python/venv, a Bun.spawn in a test, or a bare loadModelTierConfig() call is
# almost always machine-coupled). P3/P4
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
SCAN_ROOT=""

# Parse args:
#   --strict        block (exit 1) on any UNGATED P1/P2/P5 hit
#   --root <dir>    override the scan root (tests point this at a synthetic
#                   bun-apps/ tree); default = the repo root (script's ../).
while [ $# -gt 0 ]; do
	case "$1" in
		--strict) STRICT=1 ;;
		--root)   SCAN_ROOT="${2:-}"; shift ;;
		--root=*) SCAN_ROOT="${1#--root=}" ;;
		*) ;;  # ignore unknown (forward-compat)
	esac
	shift
done

if [ -n "$SCAN_ROOT" ]; then
	ROOT="$(cd "$SCAN_ROOT" && pwd)"
else
	ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
cd "$ROOT"

# Test surface: *.test.ts / *.test.mjs under bun-apps/, excluding node_modules,
# compiled dist/ (which can contain stale test artifacts), and skills/ dirs
# (vendored prompt content — e.g. s2-agent-ext-hyperframes's upstream .test.mjs
# — which is byte-identical upstream material, not this repo's test surface and
# not ours to gate or edit).
GREP_FILTERS=(--include='*.test.ts' --include='*.test.mjs' --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=skills)
TOTAL_FILES="$(
	find bun-apps -type f \( -name '*.test.ts' -o -name '*.test.mjs' \) \
		-not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/skills/*' | wc -l | tr -d ' '
)"

# guard_signals regex — if a file matches ANY of these it is GUARDED.
# PORTABILITY-GUARDED = sanctioned self-attestation: a `// PORTABILITY-GUARDED:`
# comment in the file asserts the spawn/path access is CI-safe AND states why
# (e.g. spawning bash to run a committed repo script). Used by tests that MUST
# run in CI but legitimately touch a host binary the skipIf/opt-in signals
# can't express (the audit's own regression test is the canonical case).
GUARD_RE='process\.env\.CI|\.skipIf\(|MLX_E2E|PI_AGENT_E2E|PI_RUN_L2|PI_AGENT_E2E_IMAGE|PI_AGENT_E2E_DEPLOY|PI_SKIP_L2|CONFIG_PRESENT|testWithoutEnv|__setVaultResolverForTest|process\.execPath|PORTABILITY-GUARDED'

# Pattern regexes.
P1_RE='existsSync\s*\([^)]*(python/venv|swift/|run\.py|mlx-models|video_generation__models)'
P2_RE='Bun\.spawn|spawnSync|execSync'
P3_RE='process\.env\.[A-Z][A-Z0-9_]*_(API_KEY|TOKEN)'
P4_RE='process\.env\.OB_VAULT'
# P5 — real-~/.pi config-loader CALLS (the watchdog #937 failure class: a test
# invoking loadModelTierConfig()/getModelTierConfigPath() reads the real
# machine's ~/.pi/workflows/model-tiers.json, breaking under a different/CI
# config). CALL-based (parens) so path-string literals don't false-match.
# loadConfig( is deliberately excluded: it collides with local test helpers and
# hermes's path-injected loader; os.homedir( is excluded (benign path-construction).
P5_RE='loadModelTierConfig\s*\(|getModelTierConfigPath\s*\('
# P5 guard = shared signals + hermeticity path-injection seams (tmpdir/mkdtemp/
# injected cfg path / AGENT_ROOT redirect). A config-loader call guarded by one
# of these resolves to a temp/isolated path, not the real ~/.pi.
P5_GUARD_RE="${GUARD_RE}|tmpdir\(|mkdtempSync|cfgPath|TEST_CONFIG_PATH|__setAgentRootForTest"

# Counters.
p1_guarded=0; p1_ungated=0
p2_guarded=0; p2_ungated=0
p3_guarded=0; p3_ungated=0
p4_guarded=0; p4_ungated=0
block_files=""   # P1/P2 UNGATED files (the --strict failures)

emit() { printf '%s\n' "$*"; }

scan_pattern() {
	# $1 = pattern name (P1..P5), $2 = regex, $3 = blocks-under-strict (1/0),
	# $4 = guard regex (optional; defaults to the shared GUARD_RE). P5 passes a
	# hermeticity-augmented guard so path-injected config-loader calls are GUARDED.
	local name="$1" re="$2" blocks="$3" guard_re="${4:-$GUARD_RE}"
	local hits guarded_hits ungated_hits
	hits="$(grep -rEn "$re" "${GREP_FILTERS[@]}" bun-apps 2>/dev/null || true)"
	[ -z "$hits" ] && { emit "  $name: 0 hits"; return; }
	guarded_hits=""; ungated_hits=""
	while IFS= read -r line; do
		[ -z "$line" ] && continue
		local file="${line%%:*}"
		if grep -Eq "$guard_re" "$file" 2>/dev/null; then
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
emit "patterns (P1/P2/P5 block under --strict; P3/P4 are review-only):"
scan_pattern "P1  existsSync(machine-coupled path)" "$P1_RE" 1
scan_pattern "P2  spawn/exec (host-binary probe)"    "$P2_RE" 1
scan_pattern "P3  process.env.*_API_KEY/_TOKEN"      "$P3_RE" 0
scan_pattern "P4  process.env.OB_VAULT_*"            "$P4_RE" 0
scan_pattern "P5  real-~/.pi config-loader call"     "$P5_RE" 1 "$P5_GUARD_RE"
emit ""

# --strict: fail on any UNGATED P1/P2/P5 hit (the reliably-detectable classes).
if [ "$STRICT" = "1" ]; then
	if [ -n "$block_files" ]; then
		emit "✗ --strict: UNGATED P1/P2/P5 hits in:"
		printf '%s\n' "$block_files" | sed 's/^/  /' | grep .
		emit ""
		emit "Fix: wrap the machine-coupled test in *.skipIf(process.env.CI), or gate it"
		emit "behind an env-var opt-in (MLX_E2E / PI_AGENT_E2E / PI_RUN_L2). See"
		emit ".github/TEST-PORTABILITY.md for the four failure classes + fix patterns."
		exit 1
	fi
	emit "✓ --strict: no UNGATED P1/P2/P5 hits (all machine-coupled probes are guarded)"
	exit 0
fi

emit "warn-only mode (CI v1). Re-run with --strict to block on UNGATED P1/P2/P5 hits."
emit "Full disposition of every hit: .github/TEST-PORTABILITY.md"
exit 0
