# Ticket 01 — core-bundle-seam

status: open

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
   `bun build --compile` for `bun build --target=bun --minify --entry src/cli-sh.ts
   --outdir <stage-core>`; the emitted tree (`cli-sh.js` + hashed asset files, measured
   19 sidecars under the embed manifest) is staged as the version dir's core: rename the
   entry to `s2-agent.js`, keep assets in the same directory (measured to resolve; D6).
   Embed-manifest codegen + finally-reset stay exactly as-is.
5. **`deploy/lib/core-cache.ts`** — generalize to a directory: cache the whole outdir
   under `.cores/<hash>/`, `linkCore` hardlinks every file (per-file links preserve the
   freeze/no-freeze inode story). `computeCoreHash` flags gain `--target=bun` (drop
   `--compile`); hash inputs otherwise unchanged (src tree post-codegen, pi version,
   Bun.version, entry, flags).
6. **Tests** — s2-agent: in-test `bun build --target=bun` of a probe/fixture asserting
   the anchor (bundle boots, `--ext-list` finds a fixture ext tree, no env needed);
   doctor unit test for the third classifyMode bucket. devops: core-cache multi-file
   link/freeze tests extended.

## Done-when

- `bun build --target=bun --minify` of `src/cli-sh.ts` (embed manifest ON) boots with NO
  env overrides from its own directory: `--ext-list` loads a fixture ext tree; `doctor
  --json` reports the sh deploy honestly with a passing entry check.
- A scratch `runShDeploy` (outRoot under /tmp) produces a version dir whose core is
  `s2-agent.js` + sidecar assets (no Mach-O), cache-hit on second run, `bun test` green
  in s2-agent + s2-agent-ext-devops.
- `git grep -n 'execPath' bun-apps/s2-agent/src` returns only mode-aware or
  proven-inert hits, each with a comment or PR note.
