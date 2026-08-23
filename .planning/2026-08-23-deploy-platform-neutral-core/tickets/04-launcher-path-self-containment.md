# Ticket 04 — launcher-path-self-containment

status: closed
closed: 2026-08-23 — PR branch deploy/launcher-bundled-bun-path (operator
requirement added the same day the effort closed; follow-up to tickets 02/03).

## Problem

Ticket 02 made the launcher `exec` the deploy's own `bin/bun` directly, so the
BOOT was self-contained — but every CHILD the session spawns later resolved
`bun` through PATH: `s2-agent` code does `Bun.spawn(["bun", …])` in
`ext-new.ts` and `cli/commands/loop.ts`, extension shells inherit the session
env, and the first-launch self-heal install runs `bun install`. On a machine
with a system bun of a different version, those children silently diverge from
the bun that built and booted the bundle — exactly the drift the platform
contract (same `Bun.version`) exists to prevent.

## Resolution (2026-08-23)

- `S2_AGENT_SH` (deploy/run.ts) resolves the bun once into `_bun`
  (`${S2_AGENT_BUN:-$SCRIPT_DIR/bin/bun}`), prepends its dir to PATH
  (`export PATH="$(cd "$(dirname "$_bun")" && pwd):$PATH"`), then execs
  `$_bun`. The override keeps working: PATH follows whatever `S2_AGENT_BUN`
  names, which also makes the cross-platform swap self-consistent for
  children. Header comment documents the child contract.
- `tests/deploy-e2e.test.ts` asserts both lines verbatim on the staged
  launcher, so a future template edit cannot silently drop the prepend.

## Verification

- devops `bun run check` + `bun run test` green (811 pass); deploy e2e with
  `PI_AGENT_E2E=1` 6/6 incl. the new assertions.
- Live redeploy + `verify-deploy-e2e-cli` (see map.md Context for the receipt)
  and an env probe: with `S2_AGENT_BUN` pointed at a wrapper script, the
  wrapper's `$PATH` starts with the wrapper's dir and `command -v bun` resolves
  the shim beside it — precedence over a system bun confirmed at runtime.
