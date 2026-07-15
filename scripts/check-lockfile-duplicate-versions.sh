#!/usr/bin/env bash
# check-lockfile-duplicate-versions.sh — blocks the "@earendil-works/pi-tui
# 0.80.6 vs 0.80.7" class of drift: bun.lock resolving TWO different versions
# of a package that's supposed to move in lockstep across the workspace.
#
# Why this matters more than a version mismatch in general: TypeScript treats
# a class imported from two different resolved copies of the same package as
# TWO DIFFERENT TYPES (structural typing sees separate private-field
# declarations), even though the source is identical. A duplicate resolution
# is invisible to `bun test` (JS doesn't care) and to `bun install
# --frozen-lockfile` (multiple resolved versions is a semver-valid outcome) —
# it only surfaces as a confusing tsc error in whichever downstream package
# happens to pass one copy's instance to an API typed against the other. By
# the time that happens the root cause (a stray `*`/`^0.x` range on one
# package.json while its siblings pin exact) is easy to miss.
#
# Scope: the @earendil-works/* family (pi-agent-core, pi-ai, pi-coding-agent,
# pi-tui) is the one required to be lockstep across every bun-apps/* package —
# see #577/#589's exact-pin convention. This is NOT a general "no two versions
# of anything" rule (that's normal and fine for most deps); it's scoped to the
# one family where drift has actually broken the build twice.
#
# Usage (from repo root): bash scripts/check-lockfile-duplicate-versions.sh
set -uo pipefail

LOCKFILE="bun.lock"
SCOPE='@earendil-works/'

if [ ! -f "$LOCKFILE" ]; then
	echo "ERROR: $LOCKFILE not found (run from repo root)" >&2
	exit 1
fi

# Every resolved "<name>@<version>" string in the lockfile, scoped to the
# lockstep family. Dedup by (name, version) pair first so a package referenced
# from N different workspace entries only counts once per distinct version.
pairs="$(grep -oE "\"${SCOPE}[a-zA-Z0-9_-]+@[0-9][0-9.]*\"" "$LOCKFILE" | tr -d '"' | sort -u)"

if [ -z "$pairs" ]; then
	echo "✓ lockfile-duplicate-versions: no ${SCOPE}* packages found"
	exit 0
fi

bad=0
for name in $(echo "$pairs" | sed -E 's/@[0-9][0-9.]*$//' | sort -u); do
	versions="$(echo "$pairs" | grep -F "${name}@" | sed -E "s#^${name}@##")"
	count="$(echo "$versions" | wc -l | tr -d ' ')"
	if [ "$count" -gt 1 ]; then
		echo "ERROR: ${name} resolves to ${count} different versions in ${LOCKFILE}:" >&2
		echo "$versions" | sed 's/^/    /' >&2
		echo "  fix: find the bun-apps/*/package.json with a loose range (\"*\", \"^0.x\") on" >&2
		echo "  ${name} and pin it to the same exact version as its siblings, then \`bun install\`." >&2
		bad=1
	fi
done

if [ "$bad" -eq 0 ]; then
	echo "✓ lockfile-duplicate-versions: all ${SCOPE}* packages resolve to a single version"
fi
exit $bad
