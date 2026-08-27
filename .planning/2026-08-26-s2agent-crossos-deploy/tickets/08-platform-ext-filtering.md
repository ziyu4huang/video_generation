---
type: task
status: open
spawned by: 05
---

# 08 — Per-platform ext filtering (D5 build-out)

## Question

How does the registry's platform dimension (D5, ticket 01's decision) get
built out: which exts are darwin-by-nature (movie-director, flux2/krea2/ltx
swift runners, MLX-domain tools), how is that expressed in
`bun-apps/s2-agent/src/registry-config.ts`, and how does Gate 3 verify
per-tree expected ext counts when a non-host tree can only be booted on its
own OS?

## Notes for the resolver

- Spawned from ticket 05 (2026-08-27): the D6/D7 pipeline side landed
  without it — the registry lives in the s2-agent package (separate PR
  surface), and the filtering is unobservable until t06 boots a non-host
  tree. Do it after t06's verification channel exists, so the per-tree
  Gate 3 counts are checkable, not aspirational.
- Today a win32/linux tree still ships darwin-by-nature exts (dead weight;
  they fail to load at runtime at worst). The D5 decision text is the
  authority: "non-darwin trees drop darwin-by-nature exts; registry gains
  a platform dimension; Gate 3 verifies per-tree expected counts."
- Deploy-side hook already exists: `buildExtPackage` receives the target
  spec via vendor pass-through (t05) — filtering the `enabled` list in
  `run.ts` by a registry `platforms` field is the natural seam.
