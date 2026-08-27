---
type: task
status: closed
blocked by: 03
resolution: closed 2026-08-27 — D6/D7 pipeline side landed (--target + per-target subroots + GitHub-release acquisition + vendor pass-through); D5 ext filtering re-scoped to its own follow-up ticket 08; Windows tree-side mechanics classified (build-side stands, tree-side owned by t04's launchers + t06's verification)
---

# 05 — Windows tree-layout compatibility

## Question

Which deploy-tree mechanics break on Windows and what replaces each:
`current` symlink (junction? directory copy?), colon-PATH (`:280`), `$HOME`
fallback (`:257`), `chmod a-w` freeze (`fs.ts:41-44`), `env(1)` exec,
`cp -cR` clone (BSD-only, has fallback), hardlink caches (`.cores`/`.buns`
— NTFS hardlinks exist for files), launcher exec perms?

## Resolution (2026-08-27)

**The D6/D7 pipeline side landed** (PR: crossos t05):

- **`--target <platform>-<arch>`** (default: host) at all three surfaces —
  deploy-cli (`deploy-sh-argv.ts`), the `deploy_pi_agent_sh` tool
  (`deploy-tool.ts` + extension schema). Version dirs, `.staging-*`,
  `current`, retention and the index live under `<outRoot>/<target>/`;
  `.cores`/`.buns` stay at the shared top level (`run.ts` cacheRoot vs
  targetRoot). `listTargetLayout()` (`version.ts`) enumerates the layout
  for `--list` (legacy flat dirs still render).
- **Non-host bun acquisition** (D7, closing the ticket-02 caveat):
  `acquireBunBinary()` (`lib/bun-acquire.ts`) fetches the target's
  artifact from the GitHub release tag `bun-v<Bun.version>`, verifies the
  official SHASUMS256 row (missing row = error, mismatch = error),
  extracts via bsdtar, and lands the binary in `.buns/<computeBunHash>`
  through the NEW `ensureCachedBunFrom()` (`bun-cache.ts`) — the same
  parameterized hash the host path uses, explicit identity, temp+rename
  discipline. Windows targets link as `bin/bun.exe` (D7 artifact naming;
  t04's .ps1 resolves it first). `S2_AGENT_BUN_RELEASE_BASE` overrides the
  download base (tests / local mirrors / air-gapped relays).
- **Vendor closure target pass-through**: `buildExtPackage` now forwards
  `platform`/`arch`/`libc` to `collectVendorClosure` (linux implies glibc
  per D4; musl is explicit).
- **Boot gates vs non-host trees**: Gates 3/6 (and the CLI's post-deploy
  E2E) boot the tree with its own bun — impossible for a foreign binary.
  They are recorded `status: "skip"` with the t06 deferral note; Gate 5's
  static scans still run on every tree (the shipped foreign bun IS scanned
  — string-level, no execution). Report banner treats skip ≠ fail.
- **`resolveCurrentVersionDir`** (`deploy-e2e-recipe.ts`) is
  target-aware: host subroot first, then any target subroot, then legacy
  flat — verify-deploy-e2e / session-doctor work against both layouts.

**Verified**: tsc clean; canonical `bun run test` 954 pass / 0 fail (incl.
new unit files); `PI_AGENT_E2E=1` deploy-e2e 5 pass / 0 fail — including a
REAL win32-x64 deploy from this darwin host via a fixture release: subroot
shape, `bin/bun.exe`, per-target `current`, deploy.json target facts,
skipped boot gates, and second-deploy cache hits (core AND `.buns`).

## Independent review pass (harness /code-review high, 2026-08-27)

10 confirmed/plausible findings; all substantive ones fixed pre-merge:

1. `resolveCurrentVersionDir` tried legacy-flat FIRST → stale pre-t05 tree
   verified forever on upgraded outRoots. Fixed: host subroot → legacy
   flat → other targets.
2. `acquireBunBinary` did the full network round BEFORE the cache check —
   warm cache + release-down hard-failed. Fixed: cache-first short-circuit
   (pinned by a test with an unreachable base).
3. `computeBunHash` had no libc term — `linux-x64` and `linux-x64-musl`
   collided onto one `.buns` entry (musl tree hardlinked the glibc bun).
   Fixed: libc folded when specified (host hashes unchanged); pinned by a
   collision test.
4. Legacy flat version dirs never pruned again post-t05 (unbounded disk on
   pre-t05 outRoots). Fixed: `pruneVersions(cacheRoot, { excludeTargets:
   true })` alongside the subroot prune; top-level `index.html` staleness
   accepted (cosmetic; `--list` shows truth).
5. `isHostTarget` ignored libc — musl target on a glibc host shipped the
   host bun mislabeled. Fixed: libc-aware on linux.
6. Host deploy forced `vendorLibc: "glibc"`, killing `detectLibc()`
   auto-detection for musl hosts. Fixed: host passes undefined.
7. A cross-only outRoot made verify-deploy-e2e boot `s2-agent.sh` on a
   win32 tree → false FAIL. Fixed: `isNonHostTree` shared helper +
   verify-deploy-e2e-cli skip verdict.
8. Unbounded fetches could hang the deploy. Fixed: `AbortSignal.timeout`
   per repo convention.
9. Any dash-named flat dir (`demo-run`) misclassified as a target subroot.
   Fixed: `isKnownTargetSubrootName` restricted to known platform
   families.
10. Report banner said "all pass" over skip rows. Fixed: "pass (with
    skips)".

Cleanup-class also done: shared `isNonHostTree` (was derived 3 ways),
`ensureCachedBun` delegates to `ensureCachedBunFrom`, `skipGate()` dedupes
the skip records. Not done (recorded): `findExe` vs fs.ts walk
unification.

## Re-scoped OUT (with reasons recorded)

- **D5 per-platform ext filtering** (registry platform dimension, per-tree
  Gate 3 counts) → **ticket 08**. Reason: the registry lives in the
  s2-agent package (`registry-config.ts`) — a separate PR surface from the
  devops deploy pipeline, and the filtering has zero effect until t06 can
  BOOT a non-host tree to observe ext counts. Splitting keeps this PR's
  blast radius inside `s2-agent-ext-devops`.
- **`--target all` matrix sugar** — N invocations work today; fold when a
  real matrix build is wired into CI (t06 territory).

## Windows tree-side mechanics — the classification the ticket asked for

BUILD-side mechanics run on the mac host and **stand unchanged**: the
`.cores`/`.buns` hardlink caches (hardlinks are an APFS build-side
concern; when the tree is COPIED to Windows the links resolve to copies —
harmless), `cp -cR` clone (BSD fast-path + portable fallback already),
`chmod a-w` freeze (POSIX mode bits; lost on copy to Windows, no
semantics needed there), `env(1)` exec and colon-PATH (bash launcher
only — a win32 tree's entry is the .cmd → .ps1, which use native
spellings per t04).

TREE-side mechanics (what the Windows OS touches at runtime): `current`
symlink → survives only on filesystems/transfer tools that preserve
symlinks (a zip made without symlink support drops it; a junction or a
plain re-point is the Windows-side answer — decided when t06 picks the
distribution channel), launcher entry (`s2-agent.cmd`/`.ps1` per t04,
execution policy absorbed by the Bypass shim), PATH separator (`;` in the
.ps1), `$HOME` (`$HOME` in PS = the user profile), exec perms (NTFS has
none to set). Gate 5a's symlink-escape scan is layout-based and
junction-agnostic by construction (it rejects escapes, not shapes).

## Notes for the resolver

- Split the work: BUILD-side mechanics (hardlinks, cp -c, freeze) run on the
  mac host and mostly stand; TREE-side mechanics (what the target OS touches
  at runtime) are the real port surface — classify each hit before changing
  anything.
- `verify-portability.ts` already scans for `C:\Users\` leaks — keep it
  green for the Windows templates.
- Gate 5a (no symlink resolves outside tree) needs a junction-aware reading.
