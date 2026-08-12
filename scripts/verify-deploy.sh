#!/usr/bin/env bash
# verify-deploy.sh — one-shot gate that proves the build/deploy pipeline is green.
#
# Runs the full chain a deploy depends on, in order:
#   1. bun install              (fresh node_modules — the #1 silent-break cause)
#   2. unit tests               (pure-logic gate, no GPU/model)
#   3. bundle                   (proves imports resolve → asserts workspace deps)
#   4. smoke (both entry modes) (proves the built artifact actually boots)
#   5. foreign-cwd deploy       (deploys to a temp dir + boots it from `/`:
#                                --list-models, cli version, ext doctor)
#
# Exits 0 only if every step passes. Fails LOUDLY on the first break so a bad
# deploy can never slip through silently.
#
# Usage:
#   bash scripts/verify-deploy.sh              # full chain incl. the foreign-cwd deploy
#   bash scripts/verify-deploy.sh --no-deploy  # skip step 5 (faster; no deploy build)
#   bash scripts/verify-deploy.sh --no-install # skip step 1 (reuse current node_modules)
#
# Designed to be idempotent + runnable from any cwd (paths resolved from script
# location). Safe to wire into CI or run before any release.
set -euo pipefail

# ── resolve repo root from this script's location (cwd-independent) ──────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

NO_DEPLOY=0
NO_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --no-deploy)  NO_DEPLOY=1 ;;
    --no-install) NO_INSTALL=1 ;;
    *) echo "unknown flag: $arg"; exit 2 ;;
  esac
done

# Color helpers (disabled when stdout isn't a TTY for clean CI logs).
if [ -t 1 ]; then
  G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; X=$'\033[0m'
else
  G=''; Y=''; R=''; D=''; X=''
fi

PASS=0
step() { echo ""; echo "${G}▶${X} $1 ${D}$2${X}"; }
ok()   { echo "${G}✓${X} $1"; PASS=$((PASS+1)); }
fail() { echo "${R}✗${X} $1"; echo "${R}verify-deploy FAILED at: $2${X}"; exit 1; }

echo "${G}verify-deploy${X} — build/deploy pipeline gate ${D}(repo: $REPO_ROOT)${X}"

# ── 1. fresh node_modules ────────────────────────────────────────────────────
if [ "$NO_INSTALL" -eq 1 ]; then
  echo "${Y}·${X} bun install skipped (--no-install)"
else
  step "bun install" "(fresh node_modules — prevents stale-symlink silent breaks)"
  bun install --cwd bun-apps >/dev/null 2>&1 || fail "bun install" "step 1: bun install"
  ok "node_modules fresh"
fi

# ── 2. unit tests ────────────────────────────────────────────────────────────
# (pi-agent-cli was merged into pi-agent; its suites now run under pi-agent.)
step "unit tests" "(pi-agent, no GPU/model)"
( cd bun-apps/pi-agent && bun test >/tmp/vd-pi-agent.log 2>&1 ) \
  || { tail -8 /tmp/vd-pi-agent.log; fail "pi-agent tests" "step 2"; }
ok "pi-agent: $(grep -E '^\s+[0-9]+ pass' /tmp/vd-pi-agent.log | tail -1 | xargs)"

# ── 3. bundle ────────────────────────────────────────────────────────────────
# (was two builds; pi-agent-cli is merged in. Step 3a used to call a
#  scripts/build.ts that never existed in pi-agent.)
step "bundle" "(proves all workspace imports resolve)"
( cd bun-apps/pi-agent && bun scripts/deploy.ts --no-freeze >/tmp/vd-build-agent.log 2>&1 ) \
  || { tail -10 /tmp/vd-build-agent.log; fail "pi-agent deploy --bundle" "step 3"; }
ok "pi-agent bundle ($(du -h dist/pi-agent/pi-agent.js | cut -f1))"

# ── 4. smoke (boot the built artifact, both entry modes) ─────────────────────
step "smoke" "(built artifact boots + responds)"
[ -f dist/pi-agent/pi-agent.js ] || fail "pi-agent.js missing" "step 4"
bun dist/pi-agent/pi-agent.js --list-models >/dev/null 2>&1 \
  || fail "pi-agent --list-models" "step 4a"
MODELS="$(bun dist/pi-agent/pi-agent.js --list-models 2>/dev/null | grep -c '^' || true)"
ok "pi-agent --list-models ($MODELS rows)"

bun dist/pi-agent/pi-agent.js cli version >/dev/null 2>&1 \
  || fail "pi-agent cli version" "step 4b"
ok "pi-agent cli version"

# ── 5. foreign-cwd deploy (build to a temp dir + boot it from elsewhere) ─────
#
# This step used to call `deploy.ts --verify --writable` and then grep the log
# for "deployed artifact booted". None of those three things has ever existed:
# deploy.ts rejects unknown flags, so step 5 exited 1 on its FIRST command every
# single time it ran, and the probe string has no producer anywhere in the repo.
# The full `bash scripts/verify-deploy.sh` form therefore never passed. Rewritten
# below against the real surface — `--no-freeze` is the writable-output flag, and
# the boot probes are the artifact's own commands.
#
# What it proves that step 4 does not: step 4 boots dist/ from the repo root,
# where a stray relative path still resolves. This deploys to a temp dir and
# boots it from `/` so any cwd-coupled path resolution breaks loudly.
if [ "$NO_DEPLOY" -eq 1 ]; then
  echo "${Y}·${X} foreign-cwd deploy skipped (--no-deploy)"
else
  step "foreign-cwd deploy" "(deploy to a temp dir + boot it from /)"
  DEPLOY_OUT="$(mktemp -d)/pi-agent-verify-deploy"
  ( cd bun-apps/pi-agent && bun scripts/deploy.ts "$DEPLOY_OUT" --no-freeze \
      >/tmp/vd-deploy.log 2>&1 ) \
    || { tail -15 /tmp/vd-deploy.log; fail "deploy to temp dir" "step 5"; }
  [ -f "$DEPLOY_OUT/pi-agent.js" ] \
    || fail "$DEPLOY_OUT/pi-agent.js missing after deploy" "step 5"
  ok "deployed to a temp dir ($(du -h "$DEPLOY_OUT/pi-agent.js" | cut -f1))"

  # Boot from `/` — a foreign cwd with no repo, no node_modules, no .pi/.
  ( cd / && bun "$DEPLOY_OUT/pi-agent.js" --list-models >/tmp/vd-foreign.log 2>&1 ) \
    || { tail -15 /tmp/vd-foreign.log; fail "foreign-cwd --list-models" "step 5a"; }
  ok "foreign-cwd --list-models ($(grep -c '^' /tmp/vd-foreign.log) rows)"

  # The `cli` namespace resolves its own subtree from the deployed artifact.
  ( cd / && bun "$DEPLOY_OUT/pi-agent.js" cli version >/dev/null 2>&1 ) \
    || fail "foreign-cwd cli version" "step 5b"
  ok "foreign-cwd cli version"

  # ext doctor loads every manifest extension and reports cross-extension
  # tool/command conflicts — the real form of the "0 conflicts" probe the old
  # phantom `--verify` claimed to run.
  ( cd / && bun "$DEPLOY_OUT/pi-agent.js" ext doctor >/tmp/vd-extdoctor.log 2>&1 ) \
    || { tail -20 /tmp/vd-extdoctor.log; fail "foreign-cwd ext doctor" "step 5c"; }
  ok "foreign-cwd ext doctor (extensions load, 0 conflicts)"
  rm -rf "$DEPLOY_OUT"
fi

# ── done ─────────────────────────────────────────────────────────────────────
echo ""; echo "${G}✓ verify-deploy PASSED${X} — $PASS checks green. Deploy pipeline is healthy."
