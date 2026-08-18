#!/usr/bin/env bash
# Gate: every shipped deploy artifact must BUILD and BOOT.
#
# WHY THIS EXISTS
# ---------------
# `bun run deploy` was broken from #1544 (2026-08-16) through 90 commits of
# main. power-tool is a static extension, so its `await import("playwright-core")`
# pulls a package whose bundled code requires chromium-bidi — undeclared and
# therefore never installed — and `bun build` resolves statically, so the whole
# deploy exited 1. Nothing noticed: the only jobs that build a bundle
# (deploy-verify, compile-verify) live in .github/workflows/ci.yml.disabled,
# GitHub Actions does not run in this repo, and local_ci derives its gate list
# from the `regression-gates` job alone. A shipping artifact had no gate.
#
# WHY ALL THREE MODES, AND WHY BOOT AND NOT JUST BUILD
# ----------------------------------------------------
# The modes fail independently, which is not a hypothetical: when this gate was
# written, --bundle and --exe were broken by the chromium-bidi resolve while
# --snapshot was broken by something entirely unrelated (every workspace-root
# @repo symlink copied into the artifact was dangling). deploy.ts even feeds
# OPTIONAL_EXTERNALS to the two build modes through different mechanisms —
# `external:` on the Bun.build() API vs `--external` CLI flags for
# `bun build --compile` — so one can regress while the other passes.
#
# And a build that succeeds while producing an artifact that cannot boot is the
# same silent failure in a later costume. All of it together costs ~4s, so there
# is no budget argument for checking less. (--snapshot boots itself, via
# deploy.ts's own assertSnapshotBoots.)
#
# SIDE EFFECT: deploy.ts always targets <repo>/dist/pi-agent and deletes it
# first — there is no out-dir flag. dist/ is gitignored build output and a
# freshly rebuilt one beats a stale one, so this is accepted rather than worked
# around. --no-freeze keeps the tree writable afterwards (the default --exe
# deploy chmods it a-w), and both boot smokes run against a throwaway
# PI_CODING_AGENT_DIR so they never touch the shared ~/.pi state concurrent
# agent sessions rely on.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
PKG_DIR="$REPO_ROOT/bun-apps/pi-agent"
BUNDLE="$REPO_ROOT/dist/pi-agent/pi-agent.js"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# deploy.ts hard-requires cwd == the pi-agent package dir (assertCorrectCwd).
# --no-freeze keeps dist/ writable so a later local deploy needs no --force.
if ! ( cd "$PKG_DIR" && bun ../pi-agent-ext-devops/scripts/deploy.ts --no-freeze ) > "$TMP/deploy.log" 2>&1; then
	echo "FAIL: the deploy bundle did not build."
	echo "      Reproduce: ( cd bun-apps/pi-agent && bun ../pi-agent-ext-devops/scripts/deploy.ts )"
	echo "--- deploy output ---"
	cat "$TMP/deploy.log"
	exit 1
fi

if [ ! -f "$BUNDLE" ]; then
	echo "FAIL: deploy reported success but $BUNDLE is missing."
	exit 1
fi

# Boot the artifact that was just built. PI_CODING_AGENT_DIR is pinned at a
# throwaway dir so this never writes to (or contends on) the shared agent state.
if ! ( cd "$PKG_DIR" && PI_CODING_AGENT_DIR="$TMP/agent" bun "$BUNDLE" doctor --json ) > "$TMP/doctor.json" 2>"$TMP/doctor.err"; then
	echo "FAIL: the bundle built but did not boot (doctor exited non-zero)."
	cat "$TMP/doctor.err"
	exit 1
fi

if ! python3 -c "import json,sys; sys.exit(0 if json.load(open('$TMP/doctor.json')).get('ok') else 1)"; then
	echo "FAIL: the bundle booted but doctor reported ok=false:"
	cat "$TMP/doctor.json"
	exit 1
fi

# ── Artifact 2: the standalone compiled binary (`--compile`, separate external
# plumbing from the bundle above). Same two questions: does it build, does it run.
if ! ( cd "$PKG_DIR" && bun ../pi-agent-ext-devops/scripts/deploy.ts --exe --no-freeze ) > "$TMP/exe.log" 2>&1; then
	echo "FAIL: the standalone binary did not build."
	echo "      Reproduce: ( cd bun-apps/pi-agent && bun run deploy:exe )"
	echo "--- deploy output ---"
	cat "$TMP/exe.log"
	exit 1
fi

EXE="$REPO_ROOT/dist/pi-agent/pi-agent"
if [ ! -x "$EXE" ]; then
	echo "FAIL: deploy --exe reported success but $EXE is missing or not executable."
	exit 1
fi

if ! ( cd "$PKG_DIR" && PI_CODING_AGENT_DIR="$TMP/agent-exe" "$EXE" doctor --json ) > "$TMP/exe-doctor.json" 2>"$TMP/exe-doctor.err"; then
	echo "FAIL: the binary built but did not boot (doctor exited non-zero)."
	cat "$TMP/exe-doctor.err"
	exit 1
fi

if ! python3 -c "import json,sys; sys.exit(0 if json.load(open('$TMP/exe-doctor.json')).get('ok') else 1)"; then
	echo "FAIL: the binary booted but doctor reported ok=false:"
	cat "$TMP/exe-doctor.json"
	exit 1
fi

# ── Artifact 3: the snapshot (source tree + node_modules, no bundling). Its own
# assertNoDanglingRepoLinks + assertSnapshotBoots run inside deploy.ts, so a
# non-zero exit here already means "the artifact would not have booted".
if ! ( cd "$PKG_DIR" && bun ../pi-agent-ext-devops/scripts/deploy.ts --snapshot --no-freeze ) > "$TMP/snapshot.log" 2>&1; then
	echo "FAIL: the snapshot deploy did not produce a bootable tree."
	echo "      Reproduce: ( cd bun-apps/pi-agent && bun ../pi-agent-ext-devops/scripts/deploy.ts --snapshot )"
	echo "--- deploy output ---"
	cat "$TMP/snapshot.log"
	exit 1
fi

echo "ok: bundle, standalone binary and snapshot all build and boot"
