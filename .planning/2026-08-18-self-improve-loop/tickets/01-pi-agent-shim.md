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

## Completion 2026-08-18
Shim landed (6 lines + shebang); --help boots end-to-end through bun.
