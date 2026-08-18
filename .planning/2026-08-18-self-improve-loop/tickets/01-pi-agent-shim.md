---
type: code
blocking: none
status: done
---

# 01 ./pi-agent.sh root shim (spec M1, G1)

## Question
Can the whole entrypoint be 10 lines of plain sh?

## What to build
- ./pi-agent.sh at repo root: sh shebang, exec bun bun-apps/pi-agent/src/cli.ts "$@"
  (plus minimal cd-to-repo-root guard so it works from anywhere in the repo),
  chmod +x. No other logic, no comments beyond 2 lines of purpose.

## Acceptance
- ./pi-agent.sh --help prints the cli help (end-to-end bun boot through shim).
- sh -n ./pi-agent.sh clean; file is executable.

## Completion 2026-08-18 — COMPLETED BY PRE-EXISTING SURFACE
Recon correction: ./pi-agent.sh ALREADY existed (symlink -> bun-apps/pi-agent/
run.sh, a 238-line launcher exec-ing cli.ts); the map's 'does not exist' note
was wrong. --help boots end-to-end through the symlink; launcher restored
after a dying child overwrote it with a 5-line shim (233 lines of env/
extension setup would have been lost). No new shim needed — G1 satisfied.
