# Deploy Phase 3 — hardening (implementation plan)

Spec: `.planning/specs/2026-08-20-deploy-architecture-consolidation-design.md`
("Deploy pipeline hardening" §a–d, Risk 2, Phase-3 acceptance). Phase 3 is the
final phase of the consolidation effort.

## Decisions (locked at plan time)

- **Core cache layout**: `<outRoot>/.cores/<sha256-of-build-inputs>`. The hash
  covers the `pi-agent/src/` tree **after** the embedded-assets codegen stage
  (so generated inputs are covered exactly as compiled), the resolved
  `@earendil-works/pi-coding-agent` version string, `Bun.version`, the entry
  relpath (`src/cli-sh.ts`), and the compile flag set (`--minify`). Cache is
  per-outRoot; `listVersions` already filters dot-entries, so `.cores` never
  shows up as a version.
- **freeze:false bypasses the cache entirely** (spec Risk 2): a `--no-freeze`
  deploy compiles straight to the stage dir as a plain file — never reads,
  never writes `.cores`. Only frozen deploys populate/consume the cache.
- **unfreezeTree becomes directories-only.** Unlinking a file needs the write
  bit on its parent DIRECTORY, never on the file. With `--ext` deleted nothing
  re-writes a frozen file in place, so restoring file write bits is pure risk:
  on a hardlinked core it would re-widen the mode of every version sharing the
  inode (and of the cache entry). `freezeTree` is unchanged (chmod a-w on a
  shared core is benign — every deployed core is a-w by design).
- **`--ext` deletion is total**: flag, `onlyExt` option, `mode` field, e2e
  tests, doctor hint, docs, SKILL.md rows. "Only an extension changed" is an
  ordinary deploy; with the core cache it skips the compile for free.
- **`keep` lives in the registry deploy block** (`pi-agent.registry.yaml` →
  `run-dir/registry.ts` schema authority → `config.ts` projection), default
  applied by the deploy when absent: `DEFAULT_KEEP = 5`. Prune = oldest-first
  by version-dir mtime, never fewer than `keep` dirs, never the `current`
  target (even if that means keep+1 survive). Prune runs after every full
  deploy; removal is `rmTree` (unlink-only on files now).
- **Gate 5 (relocation smoke)** runs on the staged tree before rename, after
  gate 3: clone the stage to `<outRoot>/.reloc-XXXX/` (`cp -cR` APFS clone,
  fallback `cpSync`), run `pi-agent --ext-list` there, assert the same loaded
  set, delete. A different absolute path is the whole point. Gate 4 stays.
- **DeployShResult** loses `mode`; gains `coreCached: boolean` and
  `pruned: string[]`.

## Tasks

1. **§c-1 registry schema**: `run-dir/registry.ts` `DEPLOY_KEYS` + type gain
   optional `keep` (positive integer ≥ 1); `registry.test.ts` cases;
   `pi-agent.registry.yaml` deploy block gains `keep: 5`; `config.ts` projects
   `keep` (`number | undefined`).
2. **§a core cache**: new `scripts/lib/core-cache.ts`
   (`hashCoreInputs`, `ensureCachedCore`); `deploy.ts` `buildCore` split into
   codegen → hash → cache-or-compile → hardlink; freeze:false bypass;
   `tests/core-cache.test.ts` (hash stability/sensitivity on fixture trees).
3. **§c-2 prune**: `version.ts` gains `pruneVersions(outRoot, {keep,
   protectedVersion})`; `unfreezeTree` goes directories-only (`fs.ts` header
   updated); `deploy.ts` calls it post-swapCurrent; `version.test.ts` unit
   tests (keep floor, current protected, oldest-first, dot-dirs ignored).
4. **§b delete `--ext`**: deploy.ts branch + option + `mode`; argv parser flag
   list (deploy-sh-argv.test.ts: `--ext` now an unknown-flag error);
   deploy-cli help; `src/doctor.ts` hint; e2e ext-only tests removed.
5. **§d gate 5**: `verifyRelocatable` in deploy.ts; `docs/deploy.md` five
   gates; check-deploy-e2e.sh header; deploy.md freeze section rewrite
   (no `--ext` sentence; core-cache + keep documented).
6. **e2e updates**: deploy-e2e.test.ts — full deploy unchanged; add
   second-deploy same-inode assertion (fixture registry with all extensions
   excluded keeps it cheap and still exercises cache + prune with `keep: 2`,
   4 deploys → 2 survive, `current` resolves); drop ext-only tests.
7. **Ship**: full local_ci on final HEAD, PR, merge, verify, sync, memory.

## Acceptance (spec, Phase 3)

- Deploy twice, no source change → second run reuses the cached core (same
  inode).
- Deploy `keep+2` times → oldest dirs pruned, `current` still resolves.
- `--ext` gone everywhere outside `.planning/`.
- Relocation smoke is a build gate (every deploy runs it).
- Prune never chmods a shared core; cache bypassed on `freeze: false`.
