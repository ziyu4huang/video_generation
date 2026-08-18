#!/usr/bin/env bash
#
# Lockfile freshness guard — does bun-apps/bun.lock still reflect every
# package.json in the workspace?
#
# WHY THIS EXISTS: #1586 added `yaml: ^2` to pi-agent-core-interface's
# package.json without the matching workspace block in bun.lock. With no edge
# recorded, `bun install` linked nothing into that package's node_modules, and
# main went red at RUNTIME on "Cannot find package 'yaml'" from
# embedding-leaf.ts. No typecheck could see it: tsc resolves types, and the leaf
# is only imported on the smoke path.
#
# WHY NOT `bun install --frozen-lockfile`: measured against that exact drifted
# lock, it exits 0. It verifies the lock's own resolutions are installable, not
# that the lock still reflects every package.json — so it would have shipped the
# bug unchanged. Re-resolving and diffing is what actually detects a workspace
# block missing a declared dependency.
#
# WHY A SCRIPT AND NOT AN INLINE `run:`: the gate body needs a `: ` in its error
# message and braces around its failure branch. As a YAML plain scalar that is a
# parse error, and ci-gates.ts joins a multi-line `run:` block's newlines with
# spaces — which turns two commands into one malformed one. Both were tried;
# both produced a red that had nothing to do with the lockfile. A script file
# sidesteps the quoting entirely and matches how every other gate here is
# written.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
LOCK="bun-apps/bun.lock"

cd "$REPO_ROOT"

if [ ! -f "$LOCK" ]; then
	echo "FAIL: $LOCK not found"
	exit 1
fi

# A pre-existing dirty lock is the developer's own edit, not drift this gate
# introduced. Say so plainly rather than blaming the resolve below for it.
if ! git diff --quiet -- "$LOCK"; then
	echo "FAIL: $LOCK has uncommitted changes before this check ran."
	echo "      Commit or discard them, then re-run."
	exit 1
fi

bun install --cwd bun-apps >/dev/null

if ! git diff --quiet -- "$LOCK"; then
	echo "FAIL: $LOCK is stale — re-resolving it against the workspace changed it:"
	echo
	git --no-pager diff -- "$LOCK"
	echo
	echo "Fix: run 'bun install' from bun-apps/ and commit $LOCK."
	# Leave the tree as the developer had it; the diff above is the report.
	git checkout -- "$LOCK"
	exit 1
fi

echo "ok: $LOCK is in sync with the workspace's package.json files"
