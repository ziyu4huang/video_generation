# Ticket 01 — core-bundle-seam

status: closed
closed: 2026-08-23 — implemented on feat/deploy-platform-neutral-core.

## Resolution (2026-08-23)

- `mode.ts`: `BundlerMode` regains `"bundle"` — detected by URL extension
  (binary = `$bunfs` markers checked first; source = `.ts` module URL; bundle =
  the one minified `.js`), deliberately NOT a build-time define (an env marker
  would leak into every child process — the scrub-inherited-package-dir bug
  class). New `deployRoot(url)` shared helper.
- `cli-sh.ts` ext discovery anchors on `deployRoot(import.meta.url)`;
  `PI_AGENT_SH_EXT_DIR` override unchanged. Bare `bun s2-agent.js` from a
  deploy dir now loads ext/ correctly (verified: 17/17, extRoot = deploy dir).
- `doctor.ts`: coarse "bundle" → entry = the bundle file, deployDir = selfDir,
  `shDeploy` marker includes bundle; `classifyMode(bundle+sh) = "sh"`.
  Scratch-tree `doctor --json` reports `mode: sh`, 0 fail checks.
- `skip-update-check.ts` + the three run-dir guards (`resolve.ts`,
  `deps-probe.ts`, `lazy-extensions.ts`): bundle treated as shipped artifact /
  no-repo (`mode !== "source"`).
- `run.ts`: `buildCore` = `bun build --target=bun --minify --outfile
  <stage>/s2-agent.js` against the FORCED-empty asset manifest; NEW
  `stagePiAssets()` copies pi's `dist/modes/interactive/{theme,assets}` +
  `dist/core/export-html` into the version dir (Node layout — probe-verified
  bundled pi resolves them by walking up to the deploy package.json; bundle
  boots provably never touch `~/.pi/agent/embedded-assets/`).
  `computeCoreHash` flags → `["--target=bun","--minify"]`; `ensureCachedCore`
  param renamed `compile`→`build` (shape unchanged — the core is one file
  again). `extListOf`/Gates 3/5b/6 spawn `[process.execPath, s2-agent.js]`.
- Mid-ticket scope revision (recorded in map/spec): D5/D6 replaced — no hashed
  sidecars, no multi-file `.cores`, no changes to `extract-embedded-assets.ts`
  (its `isBunBinary` gate simply never fires in bundle mode; it dies whole in
  ticket 03 with the compiled mode).
- Verified end to end: scratch `runShDeploy` to `/tmp/t01-outroot` — six gates
  green, 17 extensions, single-file 6.18 MB core + 1.1 MB `dist/` assets, cache
  hit on re-run, frozen-tree bare boot 17/17, `--version` correct. Full suites:
  s2-agent `bun run test` (1062) + `typecheck` green; s2-agent-ext-devops
  `bun run test` incl. `PI_AGENT_E2E=1` (823) green.
- **L1 e2e surfaced a real bundle-mode gap, fixed in-ticket**: pi's own `-e
  <file>` loader cannot resolve bare host specifiers from a single-file bundle
  (no `$bunfs` graph, no node_modules beside the bundle) — every `-e` probe in
  deploy-probe-e2e failed. Fix: `cli-sh` intercepts existing-file `-e`/
  `--extension` args in bundle mode, loads them via `Bun.build` (runtime
  bundler; relatives inlined, host ids external) + `evaluateExtModule`/
  `extRequire` — the same evaluation path a deployed ext.cjs uses, host-module
  members identity-preserved. NOT jiti: measured bun 1.4 quirk (see below).
  `doctor --smoke` spawns `[bun, entry]` for a bundle core (`bundleCore`
  context field); `run.sh` execs `${S2_AGENT_BUN:-bun} s2-agent.js` as the
  interim launcher until ticket 02 ships `bin/bun`.
- **bun 1.4 quirk charted** (drives the adhoc design): a process can natively
  `import()` a freshly-written tmp `.ts` roughly ONCE; afterwards new tmp
  `.ts` imports fail ("Cannot find module … from ''"). Creating a jiti
  instance (any options) or a multi-module `Bun.build` burns the shot early;
  preexisting files always keep importing fine. Deployed core unaffected
  (everything bundled); the known consumer is the repo CLI's schema-cost
  (tests now isolate the sibling-import case in a subprocess).

## Goal

The core builds as a bootable, self-locating ESM bundle: `cli-sh.ts` and `doctor.ts` know
the bundle mode, `buildCore` emits `bun build --target=bun` output (bundle + sidecar
assets), and the `.cores` cache links the multi-file tree. No launcher, no bun shipping —
this ticket is the seam everything else keys off.

## Steps

1. **`bun-apps/s2-agent/src/cli-sh.ts:39`** — replace the unconditional
   `dirname(process.execPath)` with a mode-aware anchor:
   - `PI_AGENT_SH_EXT_DIR` env override (unchanged, highest precedence);
   - bundle mode (running as a bun-run bundle; `import.meta.dir` is real) →
     `import.meta.dir`;
   - compiled mode (`import.meta.url` virtual `$bunfs`, execPath IS the app) → today's
     `dirname(process.execPath)` — keep until the compiled path is deleted in ticket 03.
   Spike receipt: `import.meta.dir` measured = the bundle's own directory; bare
   `bun s2-agent.js` today silently reports `extRoot: ~/.bun/bin/ext` with 0 extensions.
2. **Sweep `bun-apps/s2-agent/src` for other compiled-mode anchors** —
   `process.execPath`, `$bunfs`, `import.meta.url` virtual-scheme assumptions
   (`sh/host-modules.ts:76`, `sh/scrub-inherited-package-dir.ts`, `patches/`). Each hit:
   give it the same mode branch or prove it inert with a boot probe; record in the PR.
   Spike receipts: `--version`/packageDir already works beside the bundle;
   `doctor` does NOT (step 3).
3. **`bun-apps/s2-agent/src/doctor.ts:517,524`** — classify the third mode (coarse
   "bundle" ≠ compiled "binary"): `deployDir`/`entryPath` from the bundle's own
   location; mode label renders as `sh` (same deploy, new carrier); the `entry` check
   must pass against `s2-agent.js`, not `cli.ts`. Spike receipt: today's bundle reports
   `"mode": "source"` + entry FAIL.
4. **`s2-agent-ext-devops/src/deploy/run.ts` `buildCore`/`compile`** — swap
   `bun build --compile` for `bun build --target=bun --minify --outfile <target>`
   (output named `s2-agent.js`, single file: the bundle builds against the EMPTY asset
   manifest — no embed-mode codegen pass, no sidecars; D5/D6 revised). NEW: copy pi's
   three asset dirs (`dist/modes/interactive/theme`, `dist/modes/interactive/assets`,
   `dist/core/export-html`) from the resolved pi package into the stage dir at the same
   relpaths — probe-verified pi resolves them from the bundle's own walk-up with zero
   env. `computeCoreHash` flags become `["--target=bun", "--minify"]`; core-cache stays
   single-file.
5. **`run.ts` `extListOf`** — minimal spawn adaptation so Gates 3/6 run inside THIS
   ticket (a scratch deploy must pass them to flip `current`): spawn
   `[process.execPath, join(stage, "s2-agent.js"), "--ext-list"]`. Gate 5b keeps
   scanning the core artifact (now readable text). Full e2e/docs/deletion stays in
   ticket 03.
6. **Tests** — s2-agent: mode-detection unit tests (binary/bundle/source URLs) +
   in-test `bun build --target=bun` of a probe asserting the anchor (bundle boots,
   finds a fixture ext tree, no env needed); doctor unit test for the third
   classifyMode bucket. devops: deploy-run/core-cache tests updated for the new flags
   and asset-copy step.

## Done-when

- `bun build --target=bun --minify` of `src/cli-sh.ts` (empty asset manifest) boots with
  NO env overrides from its own directory: `--ext-list` loads a fixture ext tree;
  `doctor --json` reports the sh deploy honestly with a passing entry check; pi asset
  dirs resolve inside the tree (Node layout, no `PI_PACKAGE_DIR`, nothing created under
  `~/.pi/agent/embedded-assets/`).
- A scratch `runShDeploy` (outRoot under /tmp) produces a version dir whose core is a
  single `s2-agent.js` (+ copied `dist/` asset dirs, no Mach-O), cache-hit on second
  run, `bun test` green in s2-agent + s2-agent-ext-devops.
- `git grep -n 'execPath' bun-apps/s2-agent/src` returns only mode-aware or
  proven-inert hits, each with a comment or PR note.
