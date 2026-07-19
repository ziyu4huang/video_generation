# Deploy efficiency — baseline + Tier A optimizations

> **Tech note** — recorded 2026-07-03. Historical snapshot: `--release`/
> `--portable` were later replaced by `--snapshot`/`--standalone`/`--exe`
> (see `docs/deploy-cwd-trust.md`), and `scripts/build.ts` /
> `scripts/build-extensions.ts` were folded into `scripts/deploy.ts` /
> `scripts/lib/build-extensions.ts`. The mechanisms below (hash cache,
> THIN externals, sourcemap opt-in) are still accurate; the flag/file names
> in the narrative are as they were on this date.

An audit of the pi-agent deploy pipeline (`scripts/build.ts`,
`scripts/build-extensions.ts`, `scripts/deploy.ts`) for efficiency: build speed,
artifact size, and deploy-time speed. This records the baseline and the Tier A
optimizations landed the same day. See `docs/deploy-cwd-trust.md` and
`docs/deploy-readonly.md` for the deploy *contract*; this is about *cost*.

## Measured baseline (2026-07-03)

| Artifact | Size | Notes |
|---|---|---|
| `dist/pi-agent/pi-agent.js` | 6.4 MB | minified; inlines all of pi-coding-agent. Dominant cost, near tree-shake ceiling. |
| `dist/pi-agent/pi-agent.js.map` | **20 MB** | `sourcemap:"external"` — **never shipped**, just bloats dist/ + slows build |
| `dist/pi-ext-bundles/` (6 thin) | 236 KB | THIN + shared externals — near-optimal |
| assets (theme/export-html/assets) | 1.1 MB | only `--portable` copies these |
| repo `node_modules/` | 14 MB | isolated linker already applied (448M → 14M) |

Deploy output: bundle ~6.7 MB, portable ~8–10 MB. Slowest steps: the `bun build`
of pi-agent.js (parses pi's whole 8.6M dist graph) and, for portable/release,
`bun install`. ext-bundles always rebuilt (no hash cache).

## Tier A — landed 2026-07-03

### A1. Main-bundle sourcemap is opt-in (`build.ts --sourcemap`)

The 20 MB `.map` was emitted unconditionally but **never shipped** — `deploy.ts`
only `cpSync`s `pi-agent.js`. It bloated `dist/`, slowed every build, and
printed a warning. Now `sourcemap` defaults to `"none"`; pass `--sourcemap` for
in-place bundle debugging. The `//# sourceMappingURL=` comment and the trailing
warning are gated on the flag. **Zero artifact-size change** (the map was never
shipped); dist/ shrinks 20 MB and builds are faster.

### A2. Portable install uses `--production` (`deploy.ts --portable`)

`portableDeploy()` ran plain `bun install`; now `bun install --production`
(matching `releaseDeploy()`). Portable's deps are all runtime (typebox, jiti,
@earendil-works/*, npm-exts); `--production` trims devDeps that leak via the
pi-agent package.json (`@types/bun`). Smaller install, faster, consistent with
release.

### A3. ext-bundle hash cache (`build-extensions.ts`)

Each successful build writes a `<name>.<thin|full>.hash` sidecar — a sha256
(16-hex) over the entry's whole package source tree + thin/full flag +
`THIN_EXTERNALS` list + minify config + `Bun.version`. A warm run whose inputs
hash-match skips build + abs-resolve + verify ("skipped (hash match)").

- **Per-entry granularity:** only the changed ext rebuilds (proven: drop one
  sidecar → 1 built, 5 skipped).
- **OUTDIR is no longer blanket-wiped** — stale entries (mode switch THIN↔FULL,
  renamed/removed ext) are removed selectively; valid cached bundles survive.
- The sidecar is written **after** verify passes, so a half-built/failed bundle
  is never marked cache-hot.
- `.hash` files stay in `dist/` (deploy copies only `*.js`).
- `--force` bypasses the cache (escape hatch). `Bun.version` is in the hash, so
  a bun upgrade that changes codegen forces a rebuild automatically.

Verified: cold `--force` build 6/6 PASS; immediate warm run 6/6 skipped.

## Deferred (documented, not landed)

- **B1/B2** parallel ext bundling — exts are 236 KB total, the win is modest.
- **C1** `--binary` deploy mode — only if a bun-less target appears.
- **C2** `--tar` distribution — only if directory deploys become a transfer pain.
- **C3** tree-shake audit of pi-coding-agent — speculative, <100K ceiling.

## Verification

- `./run-test.sh high` — deploy e2e across all modes (no map needed).
- `./run-test.sh full` — incl. readonly + sibling stack baseline.
- Hash-skip proof at the time of writing: `( cd bun-apps/pi-agent && bun scripts/build-extensions.ts )`
  twice → second run logs "skipped (hash match)" for every ext.
  **Currently NOT exercised via `deploy.ts`**: confirmed by re-running
  `bun scripts/deploy.ts <same-dir>` twice — 0 hash hits either time. Root
  cause: `deploy.ts`'s `main()` unconditionally `rmSync(target, {recursive:true})`s
  an existing target before rebuilding, deleting the `.hash` sidecars the cache
  needs to compare against. `buildExtensions()`'s hash-cache code itself is
  intact (see `scripts/lib/build-extensions.ts` + `scripts/lib/ext-hash.ts`)
  — it just never gets a chance to hit under the current `deploy.ts` entry
  point. Flagged, not fixed as part of this note.
