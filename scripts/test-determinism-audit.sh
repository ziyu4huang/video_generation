#!/usr/bin/env bash
# test-determinism-audit.sh — mechanical, reproducible scan for the four
# cross-RUN test-determinism failure classes.
#
# Companion to test-portability-audit.sh. Where the portability audit catches
# "works on my machine" (cross-MACHINE) failures, this one catches "green on
# one run, red on the next" (cross-RUN) flakes — the class that turns a
# mandatory gate into a source of false blocks.
#
# The four classes (each cheap to grep; fix patterns proven in-tree):
#   D1  uncontrolled time — Date.now()/new Date()/.mtime in a test body whose
#       file has NO clock-injection seam. Assertions on "seconds ago" / file
#       freshness / generated timestamps drift with the wall-clock.
#   D2  real host-state writes — a portable test writes to the real ~/.pi/,
#       ~/.config, real vault, or real model dirs instead of a tmpdir.
#   D3  cross-file shared state / ordering — the node:test hang that forces a
#       one-process-per-file workaround (run-all.sh). Structural: the audit
#       reports the workaround's status (fixed = single-process run passes).
#   D4  live network — fetch()/http://127.0.0.1/localhost NOT wrapped in a
#       mock or a skipIf guard.
#
# For each hit the script classifies the file as CONTROLLED (already injects /
# mocks / isolates — the proven patterns) or UNCONTROLLED (no seam — a potential
# flake, or a file needing a seam added).
#
# Control / guard signals (any present in the file ⇒ CONTROLLED):
#   D1 (time):     __setNow | mockDate | Date.now = | setNowForTest |
#                  useFakeTimers | tickAsync | FixedDate | fixedTimestamp
#   D2 (host):     mkdtemp | tmpdir | PI_CODING_AGENT_DIR | __setAgentRootForTest |
#                  __setVaultResolverForTest | __setConfigPathForTest
#   D4 (network):  globalThis.fetch = | mockFetch | mock.module | .skipIf( |
#                  isError | graceful | unreachable
#
# Usage (from repo root):
#   bash scripts/test-determinism-audit.sh            # report (exit 0; warn-only)
#   bash scripts/test-determinism-audit.sh --strict   # exit 1 on any UNGUARDED D2 hit
#
# --strict targets D2 only — a portable test writing to the real ~/.pi/ or
# ~/.config is reliably a determinism AND safety bug (it races with live
# sessions and corrupts host state). D2 requires a write-op / store-DB
# construction to CO-OCCUR with the host-path reference, so a bare mention of
# AGENT_ROOT/homedir in a comment or a path-construction assertion does NOT
# count (that is how the audit stays low-false-positive). D1/D4 are reported
# for REVIEW but never block: a `Date.now()` is often a benign fixture seed,
# and a live-network call needs structural analysis (is it behind a skipIf /
# a mocked lookup?) that a line-grep can't do without prohibitive false
# positives — exactly like the portability audit's P3/P4. The catalog
# (.github/TEST-DETERMINISM.md) is the human-reviewed disposition for D1/D4;
# this script is the mechanical baseline.
#
# CI rollout: runs WARN-ONLY as a regression-gates step, so the report is
# visible on every PR without blocking. The companion prevention gate is the
# `determinism spot-check` job (3× flake detector), not this audit.
set -uo pipefail

STRICT=0
[ "${1:-}" = "--strict" ] && STRICT=1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Test surface: *.test.ts / *.test.mjs under bun-apps/, excluding node_modules
# and compiled dist/. (Bash 3.2-portable — no mapfile/readarray.)
GREP_FILTERS=(--include='*.test.ts' --include='*.test.mjs' --exclude-dir=node_modules --exclude-dir=dist)
TOTAL_FILES="$(
	find bun-apps -type f \( -name '*.test.ts' -o -name '*.test.mjs' \) \
		-not -path '*/node_modules/*' -not -path '*/dist/*' | wc -l | tr -d ' '
)"

# Per-class CONTROLLED signals (file matches ANY ⇒ the file is CONTROLLED).
D1_SEAM_RE='__setNow|mockDate|Date\.now =|setNowForTest|useFakeTimers|tickAsync|FixedDate|fixedTimestamp'
D2_SEAM_RE='mkdtemp|tmpdir|PI_CODING_AGENT_DIR|__setAgentRootForTest|__setVaultResolverForTest|__setConfigPathForTest'
D4_SEAM_RE='globalThis\.fetch =|mockFetch|mock\.module|\.skipIf\(|isError|graceful|unreachable|ORIG_FETCH'

# Pattern regexes.
D1_RE='Date\.now\(\)|new Date\(|\.mtimeMs|\.mtime\b'
D2_RE='homedir\(\)|os\.homedir|/\.pi/|"\.pi"|'\''\.pi'\''|AGENT_ROOT'
# D2 write-op co-occurrence: a host-path reference alone is noise (comments,
# path-construction assertions, function inputs). A real host-state WRITE pairs
# a host path with a write op / store-DB construction. This drops the benign
# hits (pure-assertion tests, constant-string tests) and keeps the real ones.
D2_WRITE_RE='writeFile|writeFileSync|mkdir|mkdirSync|appendFile|appendFileSync|rmSync|unlinkSync|new DatabaseManager|new MemoryStore|loadFromDisk'
D4_RE='\bfetch\(|http://|https://|127\.0\.0\.1|localhost|0\.0\.0\.0'

block_files=""   # D2 UNGATED files (the --strict failures)

emit() { printf '%s\n' "$*"; }

# scan_pattern <name> <pattern-re> <seam-re> <blocks-under-strict 1/0> [write-re]
# De-duplicates to FILES (one disposition per file). For D2 (write-class), pass
# write-re as $5: a file is UNGATED only if it has a host-path hit AND a write
# op AND no seam (the reliably-dangerous combo). No write op ⇒ benign
# (assertion/comment/input) ⇒ CONTROLLED for blocking purposes.
scan_pattern() {
	local name="$1" pre="$2" sre="$3" blocks="$4" write_re="${5:-}"
	local hits
	hits="$(grep -rEn "$pre" "${GREP_FILTERS[@]}" bun-apps 2>/dev/null || true)"
	[ -z "$hits" ] && { emit "  $name: 0 hits"; return; }
	local files=""
	while IFS= read -r line; do
		[ -z "$line" ] && continue
		local file="${line%%:*}"
		case "$files" in *"$file"*) ;; *) files="${files}${file}"$'\n' ;; esac
	done <<<"$hits"
	local controlled_files="" uncontrolled_files=""
	while IFS= read -r file; do
		[ -z "$file" ] && continue
		local is_controlled=0
		grep -Eq "$sre" "$file" 2>/dev/null && is_controlled=1
		if [ "$is_controlled" = "0" ] && [ -n "$write_re" ]; then
			grep -Eq "$write_re" "$file" 2>/dev/null || is_controlled=1
		fi
		if [ "$is_controlled" = "1" ]; then
			controlled_files="${controlled_files}${file}"$'\n'
		else
			uncontrolled_files="${uncontrolled_files}${file}"$'\n'
			if [ "$blocks" = "1" ]; then
				case "$block_files" in
					*"$file"*) ;;
					*) block_files="${block_files}${file}"$'\n' ;;
				esac
			fi
		fi
	done <<<"$files"
	local c u
	c="$(printf '%s' "$controlled_files" | grep -c . || true)"
	u="$(printf '%s' "$uncontrolled_files" | grep -c . || true)"
	emit "  $name: ${c} CONTROLLED files, ${u} UNCONTROLLED files"
	[ "$u" -gt 0 ] && {
		if [ "$blocks" = "1" ]; then
			emit "    [BLOCK under --strict] UNCONTROLLED files:"
		else
			emit "    [REVIEW] UNCONTROLLED files (informational, never blocks):"
		fi
		printf '%s\n' "$uncontrolled_files" | sed 's/^/      /' | grep .
	}
}

emit "═══ test-determinism audit ═══"
emit "scanned $TOTAL_FILES test files under bun-apps/ (excluding node_modules, dist)"
emit ""
emit "patterns (D2 blocks under --strict; D1/D4 are review-only):"
scan_pattern "D1  uncontrolled time (Date/now/mtime)" "$D1_RE" "$D1_SEAM_RE" 0
scan_pattern "D2  real host-state writes (host-path + write-op)" "$D2_RE" "$D2_SEAM_RE" 1 "$D2_WRITE_RE"
scan_pattern "D4  live network (fetch/http/localhost)" "$D4_RE" "$D4_SEAM_RE" 0
emit ""

# D3 — cross-file shared state / ordering. Structural: detect the one-process-
# per-file workaround (run-all.sh) and report whether the suite now runs
# single-process (fixed) or still needs the workaround.
emit "  D3  cross-file ordering (run-all.sh workaround):"
if [ -f bun-apps/s2-agent-ext-hermes-memory/tests/run-all.sh ]; then
	emit "    run-all.sh present (one-process-per-file workaround RETAINED)"
	emit "    status: see .github/TEST-DETERMINISM.md for the root-cause disposition"
else
	emit "    run-all.sh absent — suite runs single-process (workaround RETIRED, fixed)"
fi
emit ""

# --strict: fail on any UNGUARDED D2 hit (the reliably-detectable class).
if [ "$STRICT" = "1" ]; then
	if [ -n "$block_files" ]; then
		emit "✗ --strict: UNGATED D2 (real-host-state write) files:"
		printf '%s\n' "$block_files" | sed 's/^/  /' | grep .
		emit ""
		emit "Fix: route the test's host-state writes through a tmpdir (mkdtemp), or inject"
		emit "a deterministic path via PI_CODING_AGENT_DIR / __setAgentRootForTest /"
		emit "__setConfigPathForTest. See .github/TEST-DETERMINISM.md for the four"
		emit "failure classes + fix patterns."
		exit 1
	fi
	emit "✓ --strict: no UNGATED D2 hits (no portable test writes to the real host)"
	exit 0
fi

emit "warn-only mode (CI v1). Re-run with --strict to block on UNGATED D2 hits."
emit "Full disposition of every hit: .github/TEST-DETERMINISM.md"
exit 0
