#!/usr/bin/env bash
# Gate: the sh deploy's e2e — the tree is right AND the DEPLOYED binary really
# runs its extensions.
#
# WHY THIS EXISTS
# ---------------
# deploy's six build gates prove the sh tree is well-formed, but none of
# them starts a session — which is exactly how two silent defects shipped: the
# sdk-patch polyfill was dead in every deploy for a week (it warned on every
# run) and playwright's __dirname pointed at the build machine. Registration
# is not function — tests/deploy-probe-e2e.test.ts runs the real deployed
# binary offline (import-free `-e` probes that exit before any provider call),
# asserting tools, skills, cross-extension seams, doctor, and both ext/ states.
# Until this gate existed, that suite was invisible to local_ci: a red test
# nobody runs is the same as no test.
#
# TWO suites, both PI_AGENT_E2E-gated and therefore both invisible to a plain
# `bun test`:
#   deploy-e2e        the tree: freeze, version, current symlink, core-cache
#                        reuse + keep:N pruning, and the zero-extension state.
#   deploy-probe-e2e  the runtime: real sessions against the deployed binary.
# Only the probe suite was wired in when this gate was written, so deploy-e2e
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
PKG_DIR="$REPO_ROOT/bun-apps/s2-agent-ext-devops"

# ── Hermetic model/provider resolution (the deploy env-gate) ──────────────────
# The probe suites spawn the DEPLOYED binary with an ISOLATED PI_CODING_AGENT_DIR
# (a temp piHome) and a bare { ...process.env } inherited from THIS shell, so the
# real ~/.pi/agent/auth.json is never consulted. Two things must both hold for the
# real-session tests (doctor --smoke, session-start, the sandboxed session) to
# actually start:
#   1. ZAI_API_KEY must be in the invoking env. A fresh CI bash / non-interactive
#      shell does NOT source ~/.zshrc, so the key is absent, no zai auth is
#      configured, and the resolver reports "No matching provider is authenticated".
#   2. The model must be provider-qualified. The package built-in default
#      (src/pre-load-providers.ts: zai/glm-5.3) splices the BARE `glm-5.3` into
#      pi's resolver, which fuzzy-matches it across opencode-go / zai-coding-cn /
#      zai → "Model 'glm-5.3' is ambiguous across providers". PI_MODEL=zai/glm-5.3
#      qualifies it; a qualified --model also suppresses the --provider bridge
#      (model governs provider routing).
# Resolve the key from the shell rc files (mirroring scripts/claude-desktop-glm.sh)
# and qualify with fill-gaps semantics — an operator's own PI_MODEL/PI_PROVIDER or
# an exported ZAI_API_KEY always wins, so this stays a default not an override.
resolve_gate_api_key() {
	if [[ -n "${ZAI_API_KEY:-}" ]]; then
		printf '%s' "$ZAI_API_KEY"
		return 0
	fi
	local rc found=""
	for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
		[[ -r "$rc" ]] || continue
		found="$(grep -E '^[[:space:]]*export[[:space:]]+ZAI_API_KEY=' "$rc" 2>/dev/null \
			| tail -1 \
			| sed -E 's/^[^=]*=//; s/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/' \
			|| true)"
		if [[ -n "$found" ]]; then
			printf '%s' "$found"
			return 0
		fi
	done
	return 1
}

if ! GATE_ZAI_API_KEY="$(resolve_gate_api_key)"; then
	echo "FAIL: no ZAI_API_KEY in env or shell rc (~/.zshrc, ~/.bashrc, ...)." >&2
	echo "      The deploy-probe suite starts real sessions; it needs an authenticated provider." >&2
	echo "      Export ZAI_API_KEY (or add `export ZAI_API_KEY=…` to ~/.zshrc) and re-run." >&2
	exit 1
fi
export ZAI_API_KEY="$GATE_ZAI_API_KEY"
# Fill-gaps qualification: only default when the operator hasn't chosen a model.
export PI_MODEL="${PI_MODEL:-zai/glm-5.3}"
export PI_PROVIDER="${PI_PROVIDER:-zai}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

SUITES="tests/deploy-e2e.test.ts tests/deploy-probe-e2e.test.ts"

if ! ( cd "$PKG_DIR" && PI_AGENT_E2E=1 bun test $SUITES ) > "$TMP/e2e.log" 2>&1; then
	echo "FAIL: the sh deploy e2e did not pass against a fresh deploy."
	echo "      Reproduce: ( cd bun-apps/s2-agent-ext-devops && PI_AGENT_E2E=1 bun test $SUITES )"
	echo "--- e2e output ---"
	cat "$TMP/e2e.log"
	exit 1
fi

echo "ok: sh deploy e2e — the tree is well-formed and the binary runs its extensions"
