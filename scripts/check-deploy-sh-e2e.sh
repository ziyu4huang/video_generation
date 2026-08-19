#!/usr/bin/env bash
# Gate: the sh deploy's L1 e2e — the DEPLOYED binary really runs its extensions.
#
# WHY THIS EXISTS
# ---------------
# check-deploy-artifacts.sh proves the bundle/exe/snapshot artifacts build and
# boot; deploy-sh's four build gates prove the sh tree is well-formed. Neither
# starts a session, which is exactly how two silent defects shipped: the
# sdk-patch polyfill was dead in every deploy for a week (it warned on every
# run) and playwright's __dirname pointed at the build machine. Registration
# is not function — tests/deploy-sh-probe-e2e.test.ts runs the real deployed
# binary offline (import-free `-e` probes that exit before any provider call),
# asserting tools, skills, cross-extension seams, doctor, and both ext/ states.
# Until this gate existed, that suite was invisible to local_ci: a red test
# nobody runs is the same as no test.
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

if ! ( cd "$PKG_DIR" && PI_AGENT_E2E=1 bun test tests/deploy-sh-probe-e2e.test.ts ) > "$TMP/e2e.log" 2>&1; then
	echo "FAIL: the sh deploy L1 e2e did not pass against a fresh deploy."
	echo "      Reproduce: ( cd bun-apps/pi-agent-ext-devops && PI_AGENT_E2E=1 bun test tests/deploy-sh-probe-e2e.test.ts )"
	echo "--- e2e output ---"
	cat "$TMP/e2e.log"
	exit 1
fi

echo "ok: sh deploy L1 e2e — deployed binary builds and runs its extensions"
