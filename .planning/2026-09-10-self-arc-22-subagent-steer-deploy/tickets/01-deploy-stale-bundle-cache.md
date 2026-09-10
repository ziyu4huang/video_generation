# t01 — Deploy stale-bundle class: content-keyed caches + artifact attestation

Effort: 2026-09-10-self-arc-22-subagent-steer-deploy · map D1/D2/D3
Package: `bun-apps/s2-agent-ext-devops` (gates: `bun run check` = tsc, `bun test`)
Status: open

## Problem

A fresh-sha deploy (arc-19, sha `8840611`) served `ext/subagent/ext.cjs` without the
steer strings (grep `"not steerable"` = 0) and a core bundle without t03, behind a
`Bundled 2556 modules in 107ms` line. `--no-freeze --force` rebuilt fresh (both
greps = 1 post-redeploy). Nothing in the pipeline noticed. (Learning #1: the version
label is not the content; learning #2: the `@repo/*` symlink farm can serve bytes
that differ from the worktree's real packages.)

Code facts (read 2026-09-10, this worktree):

- `deploy/lib/ext-build.ts` `buildExtPackage` has NO cache — `rmSync(outDir)` +
  unconditional `bun build`. A stale ext bundle means the build READ stale bytes.
- `deploy/lib/core-cache.ts` `computeCoreHash` hashes `s2-agent/src` +
  `workspaceSrcDirs` (F2 fix present); `ensureCachedCore` hits on
  `existsSync(.cores/<hash>)`.
- `deploy/lib/bun-cache.ts` keys only runtime identity — exonerated (map D2).
- `deploy/run.ts:834` version-dir no-op (`DeployVersionExistsError` unless
  `--force`) — ruled fine (map D3), not reopened.

## Work

1. **Pin the mechanism (investigation, before the fix).** Reproduce the stale serve
   locally with a temp `outRoot` and a scratch source edit; discriminate the three
   candidates: (a) ext build read stale bytes via `node_modules/@repo/*` resolution,
   (b) `.cores` hit because hashed dirs ≠ bundler-resolved dirs, (c) stale version
   dir already at the label. Record the pinned mechanism (with commands + greps) in
   this ticket and the map's Context at close-out. Never delete the failing repro —
   it becomes the regression test.
2. **Hash what the bundler RESOLVES.** In `deploy/run.ts`'s core path, compute
   `workspaceSrcDirs` entries through the same resolution `bun build` follows
   (e.g. `Bun.resolveSync("<pkg>/package.json", piAgentDir)` → dir), not assumed
   package paths, so a symlinked/stale copy either changes the hash or fails loudly.
3. **Pre-build link-integrity gate (map D3).** New check in the deploy staging path:
   stat through every `bun-apps/node_modules/@repo/*` symlink; dangling or
  non-`../../<pkg>` targets abort the deploy with the exact repair
   (`ln -s ../../<pkg> bun-apps/node_modules/@repo/<pkg>`). Wire into the gate
   matrix report like Gates 1–5 (own stable id).
4. **Post-deploy marker attestation (map D1b).** Per rebuilt bundle (core + each
   ext), derive deterministic markers from the hashed sources — k longest unique
   string literals (k small, rule pinned by unit test; string literals survive
   minification). Extend `runDeployE2e` (both the deploy-cli auto-run and the
   standalone `verify-deploy-e2e-cli.ts` surface) to grep each deployed artifact
   for its markers; any miss → verdict `fail` with per-marker grep counts. No-op
   deploys (version-dir exists) attest against the EXISTING tree — a stale dir at
   a fresh label then fails too.
5. **Ext-side fingerprint.** Record in `ext.json` a content hash of the ext
   package's sources (scope decided per Fog-of-war: `src/` + what the bundle
   inlines, decided from the Gate-1 externals list) so attestation has its input.

## Tests

- **Stale repro test, red-on-main → green-here** (definition-of-done gate): drive
  the real build path twice into a temp outRoot with an intervening source edit
  (add a distinctive literal to a workspace src file); assert the second bundle's
  bytes differ AND the new literal is present. Must fail on main's code, pass with
  the fix. Homes: `tests/core-cache.test.ts` / `tests/deploy-run.test.ts` (or a new
  `deploy-stale.test.ts` following their harness shapes).
- Link-gate unit test: dangling + mis-pointed `@repo/*` symlinks each abort with
  the repair string; healthy link farm passes.
- Marker determinism test: same sources → same marker set across repeated runs.
- Attestation test: a bundle missing a marker → `fail` verdict naming it.

## Done when

Mechanism pinned and recorded; repro test red-on-main/green-here committed;
link gate + attestation wired into the deploy report; devops gates
(`bun run check && bun test`) green; a real `deploy-cli` run to a temp outRoot
prints the attestation results in its JSON.

## Risks

- Marker selection drifting across bun versions (mitigated by the determinism test).
- Attestation false positives aborting healthy deploys — keep k small, markers
  literal-and-unique, and count greps in the failure message for diagnosis.
