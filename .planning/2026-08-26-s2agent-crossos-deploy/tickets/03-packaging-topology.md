---
type: grilling
status: closed
blocked by: 01
resolution: closed 2026-08-27 — per-target subroots + `--target` flag; bun acquisition via GitHub release + SHASUMS256 (D6/D7)
---

# 03 — Packaging topology

## Question

Does one `deploy` invocation produce one tree per target platform (version
dirs suffixed `-linux-x64` etc., per-platform `current` pointers), or one
canonical tree whose `bin/bun` + launcher get swapped per target at
relocation time (the run.ts:236-238 contract, made one-click), or a matrix
flag (`--target bun-windows-x64`) driving separate invocations?

## Resolution (2026-08-27, user-confirmed)

**Per-target subroots** (D6): the deploy produces one complete immutable
tree per target under `<outRoot>/<target>/<version>/`, with each target
subroot owning its own `current` symlink. Driven by a `--target <name>` flag
(default: host target); a full matrix is N invocations (`--target all` sugar
is optional follow-up, not part of the ticket-04/05 contract).

- **Target names** follow D4's matrix: `darwin-arm64`, `linux-x64` (glibc
  implied; a future musl variant would be `linux-x64-musl`), `win32-x64`.
- **Caches stay shared at the outRoot top level**: `.cores/` entries are
  platform-neutral by construction (core hash folds piPkgVersion +
  Bun.version + entry + flags + src tree — no platform; `core-cache.ts:43-68`),
  `.buns/` entries are already platform-folded
  (`computeBunHash({bunVersion, platform, arch})`, `bun-cache.ts:33-37`).
  Hardlinks from cache into a subroot are same-filesystem, unchanged.
- **Zero logic change under the subroot**: `swapCurrent` / `listVersions` /
  `pruneVersions` / `.staging-<version>` all operate on the subroot as their
  outRoot — isolation falls out of the directory shape rather than new code.
- **Rejected — suffix version dirs** (`<version>-<target>` +
  `current-<target>`): semantically equivalent but every consumer
  (listVersions filter, prune protect, DeployVersionExistsError, symlink
  naming) must learn the suffix. strictly larger change surface, no payoff.
- **Rejected — canonical tree + swap-on-relocate**: cannot express D5's
  per-platform ext set in one tree; vendor closure filters by build-host
  platform, so a swapped-out linux tree would carry darwin dead weight and
  miss linux natives; the swap itself is outside the pipeline with no
  six-gate protection. The run.ts:236-238 swap contract remains valid as an
  emergency escape hatch (and `S2_AGENT_BUN` override), NOT as the packaging
  topology.

**Bun acquisition channel** (D7, closes ticket 02's ride-along): GitHub
release download + official checksums.

- Tag `bun-v<Bun.version>` carries per-target artifacts
  (`bun-darwin-aarch64`, `bun-linux-x64`, `bun-windows-x64`, …) plus
  `SHASUMS256.txt`. Version is exact against the Bun.version the core hash
  already folds — the version-exactness requirement (launcher contract:
  runtime must be the SAME Bun.version that built the bundle) is satisfied
  structurally.
- Fetched binary lands at `.buns/<computeBunHash({bunVersion, platform,
  arch})>` — the SAME hash function the host path uses, closing ticket 02's
  "hash discipline" caveat: the hash is parameterized, but `ensureCachedBun`
  (`bun-cache.ts:52-65`) only copies `process.execPath`. The build needs a
  sibling entry point that admits a foreign fetched binary into the cache
  (temp + rename + chmod 0o755, same discipline). Implementation lives in
  ticket 05's build work.
- Windows artifact unzips to `bun.exe` — the `bin/bun` vs `bin/bun.exe`
  naming and the launcher's reference to it are ticket 04/05 surface.
- Rejected — npm `@oven/*` platform-package extraction: also version-exact,
  but depends on the wrapper's internal tarball layout (an implementation
  detail that can change) and computes its own checksums. GitHub releases
  are the straighter line to the `.buns/<hash>` contract.
- Both channels are BUILD-side only; D3 / Gate 5 target-side offline posture
  is untouched.

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
