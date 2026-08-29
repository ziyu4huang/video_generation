---
type: task
blocking: 02
status: closed
---

# 03 — Dist `AGENTS.md`: agent-facing usage guide

## Question

What does an agent that discovers the dist (no repo access) need to read to
use the standalone import mechanism correctly?

## What to build

The deploy writes/refreshes `AGENTS.md` at the dist OUTROOT (next to the
platform dirs — not per version dir, so it survives version rotation and
travels with a copied tree). Content (English, version-agnostic, references
the `current` symlink): the one-line purpose; the `loadExt` / `listExts`
quickstart with a working devops dry-run example; the discovery recipe
(`listExts()` → tool names → params from the tool's schema); a
context-freedom table (git/spawn tools: standalone-safe; model/session-
backed tools: need env endpoints); the offline contract (no network, no
`bun install`, dist-local bun runtime note: run scripts with the shipped
`bin/bun` when the host lacks bun); provenance pointers (`deploy.json`,
`current`). Written from a maintained source string in the deploy lib —
never hand-edited in the dist (freeze makes that impossible anyway).

## Acceptance

- [ ] A deploy writes `<outRoot>/AGENTS.md`; a re-deploy refreshes it
      idempotently (content-hash stable across deploys when the mechanism
      is unchanged)
- [ ] The quickstart example is literally the code the t04 E2E probe
      executes (doc and proof cannot diverge)
- [ ] No version-pinned strings (no `0.7.x` literals — uses `current`)
- [ ] Deploy gates stay green; `AGENTS.md` does not trip the offline
      containment scan
