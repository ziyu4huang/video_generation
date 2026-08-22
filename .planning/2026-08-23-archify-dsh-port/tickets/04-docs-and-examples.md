---
type: task
blocking: 02
status: open
---

# 04 — Docs + example artifacts + skill guidance

## Question

Document the DSH bundle's surface and ship example IR + a deck config so a fresh agent/operator can exercise
all four tools.

## What to build

A `README.md` (install, the four tool shapes, the Bun runtime requirement), example IR fixture(s) plus a deck
manifest under `examples/`, and condensed skill guidance so an agent knows the
validate → render → delta → export flow.

## Acceptance

- [ ] README covers install (tarball + `dsh plugin`), the four tools, and the Bun runtime requirement
- [ ] `examples/` has a rendered architecture IR and a deck config that builds
- [ ] A skill/guidance doc states validate-before-render and the architecture-only delta constraint
