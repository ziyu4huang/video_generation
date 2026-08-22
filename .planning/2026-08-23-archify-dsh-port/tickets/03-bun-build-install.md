---
type: task
blocking: 01
status: open
---

# 03 — Bun build/install script + patch validation

## Question

Replace the bash `build.sh` with a Bun script that assembles the tarball and validates the bundle patch.

## What to build

`scripts/build.ts` (run via `bun`) that mirrors `vendored/`, packs the tarball, validates that
`cordis.patch.yml` composes against a dsh profile dump, and optionally installs the tarball into a profile
(`dsh plugin --profile <name> add`). No top-level bash is authored; the script stays a Bun entry.

## Acceptance

- [ ] `bun scripts/build.ts` produces `dist/dsh-archify-<version>.tgz`, self-contained (`plugin/` + `vendored/` + deps)
- [ ] `bun scripts/build.ts --check-patch <profile>` composes the patch layer cleanly (exit 0)
- [ ] `bun scripts/build.ts --install <profile>` adds the tarball and prints the restart hint
- [ ] README documents build / install / remove and the full-disable knob (the `BUN_PI_ARCHIFY=0` analog)
