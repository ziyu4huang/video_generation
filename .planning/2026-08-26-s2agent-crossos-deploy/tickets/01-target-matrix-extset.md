---
type: grilling
status: closed
resolution: decided 2026-08-26 by the user (grilling, two AskUserQuestion rounds)
---

# 01 — Target matrix + ext-set policy

## Question

Which OS/arch variants does the first cross-OS deploy pack (mac arm64/x64?
linux glibc x64/arm64? musl? windows x64/arm64?), and what happens to
darwin-by-nature exts (movie-director, flux2, krea2, ltx, and anything else
MLX/MPS-bound) in non-darwin trees — filtered out per-platform, shipped but
doctor-flagged, or shipped as-is?

## Notes for the resolver

- The registry (`s2-agent/src/registry-config.ts`) has `enabled:` flags but
  no platform dimension today; sharp-in-hyperframes precedent shows disabled
  exts drop out of deploys cleanly.
- Gate 3 (ext-list via the tree's own bin/bun) runs per tree — a filtered
  ext set changes the expected count per platform.
- The answer feeds every downstream ticket (topology, launcher scope,
  verification matrix). Record the matrix as the ticket resolution, not in
  the map body.

## Resolution (2026-08-26, user)

- **Target matrix v1 = `{darwin-arm64 (status quo), linux-x64-glibc,
  win32-x64}`.** arm64 Linux/Windows variants stay in the map's fog until a
  concrete need; musl stays fog (detectLibc machinery exists if wanted
  later).
- **Ext-set policy = per-platform filtering.** Non-darwin trees DROP
  darwin-by-nature exts (movie-director, flux2, krea2, ltx, and any other
  MLX/MPS-bound entry found at implementation time); the registry gains a
  platform dimension (per-entry `platforms:` or an explicit darwin-only
  list — shape decided in implementation, Gate 3 verifies each tree against
  ITS expected ext count). The disabled-hyperframes precedent (clean drop)
  is the model.
