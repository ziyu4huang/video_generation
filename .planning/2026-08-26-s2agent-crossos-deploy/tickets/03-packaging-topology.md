---
type: grilling
status: open
blocked by: 01
---

# 03 — Packaging topology

## Question

Does one `deploy` invocation produce one tree per target platform (version
dirs suffixed `-linux-x64` etc., per-platform `current` pointers), or one
canonical tree whose `bin/bun` + launcher get swapped per target at
relocation time (the run.ts:236-238 contract, made one-click), or a matrix
flag (`--target bun-windows-x64`) driving separate invocations?

## Notes for the resolver

- Current versioning: `<outRoot>/<version>/` + `current` symlink + retention
  by nlink (`version.ts:38-50`, `run.ts:678-688`); per-platform suffixes
  change `current` semantics (per-platform `current-windows-x64`?).
- The `.cores`/`.buns` content-addressed caches are already
  platform-parameterized in the bun hash — topology should reuse, not fork.
- Ride-along: pick the bun acquisition channel (npm-extract vs GitHub
  release) here — ticket 02 left it open deliberately.
- vendor-closure pass-through (`vendor-closure.ts:183` defaults to host
  platform) gets its target argument from this topology.
