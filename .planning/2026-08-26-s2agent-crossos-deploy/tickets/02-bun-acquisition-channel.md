---
type: research
status: closed
resolution: answered at chart time 2026-08-26 — npm channel official + viable; GitHub releases the pin-exact alternative; decision of WHICH belongs to ticket 03's topology
---

# 02 — Per-platform bun acquisition channel

## Question

How does the build host acquire same-Bun.version binaries for the non-host
platforms — the official npm `bun` package's platform payloads, GitHub
release downloads, or both?

## Resolution (2026-08-26, research fired at chart time)

- **npm channel is official and cross-OS**: `npm install -g bun` has worked
  on Windows/macOS/Linux since Bun 1.1 (official docs + community sources).
  The npm `bun` wrapper fetches per-platform binaries via @oven/* platform
  packages — i.e. the npm registry IS a supported distribution channel for
  the raw binaries, usable build-side without executing the wrapper's
  postinstall: the platform packages can be extracted directly.
- **GitHub releases are version-exact**: bun release artifacts are published
  per target (bun-linux-x64, bun-windows-x64, …) with checksums — the
  straightest match for the `.buns/<hash>` content-addressed cache, which
  keys on Bun.version+platform+arch (`bun-cache.ts:35-52`).
- **Cross-compile of bun itself is irrelevant here** (we ship prebuilt bun,
  we never build bun) — the Bun 1.1 cross-compile feature (`bun build
  --compile --target=bun-windows-x64`) exists but is OUT per D2.
- **Caveat carried forward**: whichever channel, acquisition is BUILD-side
  only (network) — Gate 5's target-side offline posture is unaffected
  (recon §8; D3). Hash discipline: the fetched binary must land in
  `.buns/<hash>` under the SAME hash function the host bun uses, so a
  platform-swapped tree stays content-addressed.
- Sources: bun.com/docs project/building-windows; oven-sh bun docs
  executables page; github.com/oven-sh/bun issues #25346, #3473;
  developer.mamezou-tech.com bun cross-compile blog (2024).

**Choice of channel (npm-extract vs GitHub release download) is left to
ticket 03's topology decision** — it rides on whether the pipeline prefers
registry-mediated or URL+checksum acquisition.
