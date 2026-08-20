# Deploy Phase 1b — collapse `"bundle"` out of the runtime

> Executes the Phase-1b section of
> `.planning/specs/2026-08-20-deploy-architecture-consolidation-design.md`.
> Phase 1a (#1740, `0f9f8bda3`) deleted the four legacy deploy modes and the
> `scripts/deploy.ts` that produced them. This phase removes the *runtime* that
> served one of them.

**Goal:** `BundlerMode` and `DeployMode` describe only states a pipeline can
actually produce.

**Why now:** the branch is provably dead, not merely unused. `deploy-bundle`
layout resolution keys on a `.deploy-bundle` marker file plus an `ext-bundles/`
directory. Verified on `912bad546`: **no file in the repo writes either one.**
Every remaining mention is a reader, a doctor probe, or a comment. Dead code
that still type-checks is worse than absent code — `set-package-dir.ts` walks up
from `__dirname` for a bundle that can no longer exist, and every future reader
has to re-derive that it is unreachable.

**Non-goal:** renaming `deploy:sh` → `deploy`. That name appears in `SKILL.md`
and `CLAUDE.md`; it is Phase 3 cleanup, not this phase.

---

## Verified surface (re-derived from `912bad546`, not from the spec)

The spec named `run-dir/resolve.ts` at `src/run-dir/`. It is at
`bun-apps/pi-agent/run-dir/`. Re-derive before editing — nine worktrees are
active and paths move.

| File | Lines | What goes |
|---|---|---|
| `src/mode.ts` | 37 | `"bundle"` leaves `BundlerMode`; `detectMode` fallthrough |
| `src/doctor.ts` | ~600 | `"bundle"` leaves `DeployMode`; `classifyMode`'s two bundle returns; `dotDeployBundle` marker; `ext-bundles` count check; `extDirFor` bundle arm |
| `run-dir/resolve.ts` | 335 | `RunDirLayoutMode`, `detectRunDirMode`, the `deploy-bundle` branch, `buildBundleArgv`, `buildBundleArgvFromLayout` |
| `run-dir/run-context.ts` | 64 | both `mode === "bundle"` branches |
| `run-dir/deps-probe.ts` | 317 | three `mode === "bundle"` guards |
| `src/patches/set-package-dir.ts` | 63 | the whole file is the bundle `__dirname` walk-up |
| `run.sh` | 213 | the `pi-agent.js` entry-detection arm |
| `pi-agent-ext-obsidian/src/lib/vault-resolution.ts` | — | `selfDir.includes("ext-bundles")` branch |

Tests that must move with them: `mode.test.ts`, `doctor.test.ts`,
`resolve.test.ts`, `set-package-dir.test.ts`, and `e2e-launcher.test.ts`'s three
`pi-agent.js` / `.deploy-readonly` cases (deliberately KEPT in 1a because the
launcher arm they cover was still live — it stops being live in this phase).

`doctor.test.ts` carries a `KNOWN_ORPHANS = {bundle}` guard written to fail in
BOTH directions. It **will** go red here. That is its job: it forces this phase
to update it rather than leave a stale orphan list.

---

## Ordering rule

Same as 1a: **preserve, then delete.** The tree must compile and `local_ci` must
be green after every commit. Delete a test only in the same commit as the
behaviour it covers — never one PR ahead.

---

## Tasks

### Task 1: prove the branch is dead, in a test

The deletions below are only safe because nothing writes the markers the branch
keys on. State that as an executable fact BEFORE removing anything, so the claim
is reviewable and stays true.

- [ ] **Step 1** — add `bun-apps/pi-agent/src/__tests__/dead-deploy-markers.test.ts`:
  scan `bun-apps/**` source (comments stripped, `node_modules` skipped) and
  assert no line writes `.deploy-bundle` or creates an `ext-bundles/` directory
  — i.e. no `writeFileSync`/`mkdirSync`/`cp`/`>` targeting either name.
- [ ] **Step 2** — falsify it: add a throwaway file that writes `.deploy-bundle`,
  watch the test go red, delete the file. A guard nobody has seen fail is a
  guard nobody knows works.
- [ ] **Step 3** — commit. Every deletion after this one cites this test.

### Task 2: `mode.ts`

- [ ] `BundlerMode` = `"binary" | "source"`. `detectMode` returns `"source"`
  when not binary — and its `sourceMarker` parameter loses its meaning, since
  every non-binary URL is now source. Decide explicitly: keep the parameter
  (callers pass a marker for readability) or drop it. Prefer DROPPING it —
  an argument that cannot change the result is a trap.
- [ ] Update `mode.test.ts`. Run `bun test src/mode.test.ts`. Commit.

### Task 3: `set-package-dir.ts`

- [ ] The file exists only for the bundle case (`shouldSetPackageDir` returns
  `mode === "bundle" && !!piPkgDir`). Delete the file, its test, and its call
  site in the patch chain. Check `src/generated/pi-pkg-dir.ts` — if nothing else
  reads it, its generator step goes too.
- [ ] Commit.

### Task 4: `run-dir/` — resolve, run-context, deps-probe

- [ ] `resolve.ts`: delete `RunDirLayoutMode`, `detectRunDirMode`, the
  `deploy-bundle` branch, `buildBundleArgv`, `buildBundleArgvFromLayout`.
  `resolveRunDirArgvUnfiltered` keeps its binary guard and its source path.
- [ ] `run-context.ts`: both `mode === "bundle"` branches. Check whether
  `runDirBase` / `src/generated/run-dir-base.ts` still has a consumer; if only
  bundle mode read it, the generator step goes too — but verify, do not assume:
  `deps-probe.ts` also mentions it.
- [ ] `deps-probe.ts`: the three `mode === "bundle"` guards collapse to the
  `binary` guard alone.
- [ ] Update `resolve.test.ts`. Run the pi-agent suite. Commit.

### Task 5: `doctor.ts`

- [ ] `DeployMode` = `"source" | "binary" | "sh"`. `classifyMode` loses its
  bundle arms — its `coarse` parameter narrows to `"source" | "binary"` too.
- [ ] `LayoutMarkers.dotDeployBundle` goes; `shDeploy` stays.
- [ ] The `ext-bundles/*.js` count check and `extDirFor`'s bundle arm go.
- [ ] `doctor.test.ts`: empty `KNOWN_ORPHANS`. Test (b) — "every KNOWN orphan is
  still reachable" — must be **deleted or emptied**, not skipped.
- [ ] Commit.

### Task 6: `run.sh` + `e2e-launcher.test.ts`

- [ ] Drop the `pi-agent.js` entry-detection arm and the `deployed (bundle)`
  MODE string.
- [ ] In the SAME commit, delete the three e2e cases it covers:
  `"pi-agent.js alone -> deployed (bundle)"`,
  `".deploy-readonly sets JITI_FS_CACHE and PI_CODING_AGENT_DIR for the child"`,
  `"PIAGENT_DEBUG=1 also prints the read-only export line"`.
- [ ] `PI_AGENT_E2E=1 bun test src/__tests__/e2e-launcher.test.ts`. Commit.

### Task 7: obsidian's dead bundle branch

- [ ] `vault-resolution.ts`: `selfDir.includes("ext-bundles")` is the same
  family of path-string heuristic the dependency-probe fix just retired. Delete
  the branch and its test case.
- [ ] `( cd bun-apps/pi-agent-ext-obsidian && bun run typecheck && bun test )`.
  Commit.

### Task 8: renames

- [ ] `scripts/deploy-sh.ts` → `scripts/deploy.ts`;
  `src/deploy-sh-cli.ts` → `src/deploy-cli.ts`;
  `scripts/lib/sh-*.ts` → `scripts/lib/*.ts`;
  `scripts/check-deploy-sh-e2e.sh` → `scripts/check-deploy-e2e.sh` (repo root).
- [ ] **The `sh-` prefix distinguished the new pipeline from the legacy one.
  The legacy one is gone, so the prefix now only adds noise.** Update every
  importer, `ci.yml.disabled`'s step, `ci-workflow-references.test.ts`'s
  vacuity floor, and `deploy-run.ts`'s repo-locator probe — the last one is the
  near-miss from 1a: it uses `existsSync(scripts/deploy-sh.ts)` to decide "is
  this a source checkout", so a rename without updating it makes `pi_verify`
  refuse with a misleading error.
- [ ] Commit.

### Task 9: docs fold

- [ ] `docs/deploy-cwd-trust.md` (158 L), `docs/deploy-readonly.md` (81 L),
  `docs/deploy-single-binary.md` (276 L) → one `docs/deploy.md` built on
  `docs/deploy-sh.md` (253 L). Keep only what is true of the sh pipeline.
- [ ] `PRD.md` and `README.md` still document `run-test.sh high|readonly` and
  the four modes. Both are now wrong — fix or delete those sections.
- [ ] `bun run test:adr` from `bun-apps/` (ADR citations). Commit.

### Task 10: full verification

- [ ] `bun bun-apps/pi-agent-ext-devops/src/local-ci-cli.ts` — all gates.
- [ ] Deploy and check the loaded set is unchanged:
  `bun run --cwd bun-apps/pi-agent deploy:sh` then
  `~/proj/dist/pi-agent-sh/current/pi-agent --ext-list` →
  `loadedCount: 14`, `skipped: []`.
- [ ] Re-run `local_ci` AFTER rebasing onto whatever `origin/main` has become.
  This repo has gone red from a clean merge of two green PRs; `local_ci` tests
  the BRANCH tree and never reports BEHIND.
