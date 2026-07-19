#!/usr/bin/env bash
# verify-deploy.sh — one-shot gate that proves the build/deploy pipeline is green.
#
# Runs the full chain a deploy depends on, in order:
#   1. bun install              (fresh node_modules — the #1 silent-break cause)
#   2. unit tests (both pkgs)   (pure-logic gate, no GPU/model)
#   3. bundles (both pkgs)      (proves imports resolve → asserts workspace deps)
#   4. smoke (version + models) (proves the built artifacts actually boot)
#   5. deploy --verify          (builds a deploy + boots it from a foreign cwd
#                                + probes getAllTools / canary tools / 0 conflicts)
#
# Exits 0 only if every step passes. Fails LOUDLY on the first break so a bad
# deploy can never slip through silently.
#
# Usage:
#   bash scripts/verify-deploy.sh              # full chain incl. deploy --verify
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
step "unit tests" "(pi-agent + pi-agent-cli, no GPU/model)"
( cd bun-apps/pi-agent && bun test >/tmp/vd-pi-agent.log 2>&1 ) \
  || { tail -8 /tmp/vd-pi-agent.log; fail "pi-agent tests" "step 2a"; }
ok "pi-agent: $(grep -E '^\s+[0-9]+ pass' /tmp/vd-pi-agent.log | tail -1 | xargs)"

( cd bun-apps/pi-agent-cli && bun test >/tmp/vd-pi-cli.log 2>&1 ) \
  || { tail -8 /tmp/vd-pi-cli.log; fail "pi-agent-cli tests" "step 2b"; }
ok "pi-agent-cli: $(grep -E '^\s+[0-9]+ pass' /tmp/vd-pi-cli.log | tail -1 | xargs)"

# ── 3. bundles ───────────────────────────────────────────────────────────────
step "bundles" "(proves all workspace imports resolve)"
( cd bun-apps/pi-agent && bun scripts/build.ts >/tmp/vd-build-agent.log 2>&1 ) \
  || { tail -10 /tmp/vd-build-agent.log; fail "pi-agent build" "step 3a"; }
ok "pi-agent bundle ($(du -h dist/pi-agent/pi-agent.js | cut -f1))"

( cd bun-apps/pi-agent-cli && bun scripts/build.ts >/tmp/vd-build-cli.log 2>&1 ) \
  || { tail -10 /tmp/vd-build-cli.log; fail "pi-agent-cli build" "step 3b"; }
ok "pi-agent-cli bundle ($(du -h dist/pi-agent-cli/cli.js | cut -f1))"

# ── 4. smoke (boot the built artifacts) ──────────────────────────────────────
step "smoke" "(built artifacts boot + respond)"
[ -f dist/pi-agent-cli/cli.js ] || fail "cli.js missing" "step 4"
bun dist/pi-agent-cli/cli.js version >/dev/null 2>&1 \
  || fail "pi-agent-cli version" "step 4a"
ok "pi-agent-cli version"

bun dist/pi-agent/pi-agent.js --list-models >/dev/null 2>&1 \
  || fail "pi-agent --list-models" "step 4b"
MODELS="$(bun dist/pi-agent/pi-agent.js --list-models 2>/dev/null | grep -c '^' || true)"
ok "pi-agent --list-models ($MODELS rows)"

# ── 5. deploy --verify (boot from a foreign cwd + probe tools) ───────────────
if [ "$NO_DEPLOY" -eq 1 ]; then
  echo "${Y}·${X} deploy --verify skipped (--no-deploy)"
else
  step "deploy --verify" "(build deploy + boot from /tmp + probe getAllTools)"
  DEPLOY_OUT="$(mktemp -d)/pi-agent-verify-deploy"
  ( cd bun-apps/pi-agent && bun scripts/deploy.ts "$DEPLOY_OUT" --verify --writable \
      >/tmp/vd-deploy.log 2>&1 ) \
    || { tail -15 /tmp/vd-deploy.log; fail "deploy --verify" "step 5"; }
  grep -q "deployed artifact booted" /tmp/vd-deploy.log \
    || { tail -15 /tmp/vd-deploy.log; fail "deploy verify probe" "step 5 (no probe line)"; }
  ok "deploy --verify green (tools + canaries + 0 conflicts)"
  rm -rf "$DEPLOY_OUT"
fi

# ── done ─────────────────────────────────────────────────────────────────────
echo ""; echo "${G}✓ verify-deploy PASSED${X} — $PASS checks green. Deploy pipeline is healthy."
