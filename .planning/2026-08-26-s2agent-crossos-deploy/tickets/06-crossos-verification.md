---
type: grilling
status: open
blocked by: 03
---

# 06 — Cross-OS verification strategy

## Question

How is a Windows/Linux tree VERIFIED when the build host is a mac —
structural gates only (gates 1-5 on host, boot deferred), CI runners
(windows/linux) running `verify-deploy-e2e`, a manual operator checklist, or
deferred entirely to first real deployment?

## Notes for the resolver

- `verify-deploy-e2e-cli.ts` boots `./s2-agent.sh` with the tree's own
  `bin/bun` — a PE bun cannot boot on macOS, full stop. Linux x64 trees
  MIGHT boot via Docker/colima on this machine (unverified — check what's
  installed before proposing).
- The post-deploy auto-E2E contract (`deploy-cli.ts:63-77`) needs a
  platform-aware skip or a structural-only mode for non-host targets.
- Model-call probes depend on LM Studio reachability — irrelevant on CI
  runners; decide what the reduced probe set is off-host.
