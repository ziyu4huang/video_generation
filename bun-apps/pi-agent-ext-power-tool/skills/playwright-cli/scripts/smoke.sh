#!/usr/bin/env bash
# Hermetic smoke for the playwright-cli skill.
#
# Proves the deploy-integrity contract: `bunx playwright-cli` resolves THIS
# extension's pinned @playwright/cli dep — exact version match, which rules out
# the unrelated npm package literally named `playwright-cli` (v0.262.0) that
# `npx playwright-cli` would fetch. Does NOT launch a browser (that needs
# `bunx playwright-cli install-browser`); this gates the invocation path, not
# engine/browser availability.
#
# Run: bash skills/playwright-cli/scripts/smoke.sh
set -euo pipefail

# Script lives at <power-tool>/skills/playwright-cli/scripts/smoke.sh
# → power-tool root is three levels up.
EXT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$EXT_ROOT"

fail() { echo "FAIL: $*" >&2; exit 1; }

# Exact version installed in node_modules — what bunx MUST resolve to.
pinned="$(grep -m1 '"version"' node_modules/@playwright/cli/package.json | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')" \
	|| fail "node_modules/@playwright/cli not installed — run 'bun install'"

# 1. binary resolves + runs, reporting the EXACT pinned version (rules out the
#    npm playwright-cli@0.262.0 naming collision, which would report 0.262.x).
v="$(bunx playwright-cli --version 2>/dev/null)" \
	|| fail "bunx playwright-cli --version exited $? — dep not resolvable from $EXT_ROOT"
[ "$v" = "$pinned" ] \
	|| fail "bunx resolved version '$v' != pinned @playwright/cli '$pinned' — wrong package (npm playwright-cli@0.262.0 collision?)"
echo "ok: bunx playwright-cli --version => $v (== pinned @playwright/cli)"

# 2. a real subcommand that does not launch a browser (lists browser sessions).
bunx playwright-cli list >/dev/null 2>&1 \
	|| fail "bunx playwright-cli list exited $?"
echo "ok: bunx playwright-cli list"

echo "playwright-cli skill smoke: PASS"
