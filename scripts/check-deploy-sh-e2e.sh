#!/usr/bin/env bash
# Gate: the sh deploy's e2e — the tree is right AND the DEPLOYED binary really
# runs its extensions.
#
# WHY THIS EXISTS
# ---------------
# deploy-sh's four build gates prove the sh tree is well-formed, but none of
# them starts a session — which is exactly how two silent defects shipped: the
# sdk-patch polyfill was dead in every deploy for a week (it warned on every
# run) and playwright's __dirname pointed at the build machine. Registration
# is not function — tests/deploy-sh-probe-e2e.test.ts runs the real deployed
# binary offline (import-free `-e` probes that exit before any provider call),
# asserting tools, skills, cross-extension seams, doctor, and both ext/ states.
# Until this gate existed, that suite was invisible to local_ci: a red test
# nobody runs is the same as no test.
#
# TWO suites, both PI_AGENT_E2E-gated and therefore both invisible to a plain
# `bun test`:
#   deploy-sh-e2e        the tree: mode, freeze, version, current symlink,
#                        ext-only rebuild, and the zero-extension state.
#   deploy-sh-probe-e2e  the runtime: real sessions against the deployed binary.
# Only the probe suite was wired in when this gate was written, so deploy-sh-e2e
# ran nowhere. It went stale on #1713 and outright red on #1738 — it asserted a
# literal ["power-tool", "task"] while the base set grew to fourteen — and no
# gate said a word for two releases. Both run here now.
#
# Runtime is dominated by one runShDeploy (~seconds of compile + a 13 MB
# playwright-core copy), comfortably inside the local_ci budget. The step in
# ci.yml.disabled must stay `if:`-free — parseCiGates refuses the whole gate
# list rather than guess at conditionals.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
PKG_DIR="$REPO_ROOT/bun-apps/pi-agent-ext-devops"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

SUITES="tests/deploy-sh-e2e.test.ts tests/deploy-sh-probe-e2e.test.ts"

if ! ( cd "$PKG_DIR" && PI_AGENT_E2E=1 bun test $SUITES ) > "$TMP/e2e.log" 2>&1; then
	echo "FAIL: the sh deploy e2e did not pass against a fresh deploy."
	echo "      Reproduce: ( cd bun-apps/pi-agent-ext-devops && PI_AGENT_E2E=1 bun test $SUITES )"
	echo "--- e2e output ---"
	cat "$TMP/e2e.log"
	exit 1
fi

echo "ok: sh deploy e2e — the tree is well-formed and the binary runs its extensions"
