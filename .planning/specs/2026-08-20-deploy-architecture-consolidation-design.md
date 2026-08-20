# Deploy architecture consolidation — one pipeline, one registry, one bundler

Date: 2026-08-20
Status: Phase 1 SHIPPED (#1740 1a, #1745 1b, #1747 renames). Phase 2 revised
2026-08-20 to synthesise with #1739's generated `static-extensions.ts`; 2a in
flight. Phase 3 pending.
Base: `origin/main` @ 782d99b8a (Phase 2 base: `bee29db52`)
Supersedes the non-goals of `.planning/specs/2026-08-19-pi-agent-sh-deploy-design.md`
(which explicitly deferred "replacing or deleting the existing four deploy modes").
That deferral was correct while `deploy-sh` was unproven; it has since shipped,
carries five gates and an L1 e2e, and is the only artifact anyone runs.

## Problem

One capability — "package pi-agent so it can run somewhere" — is implemented five
times, into two artifact trees, from three independent extension registries, by two
independent bundlers.

### Five pipelines, two trees

| pipeline | artifact | portable? | actual consumer |
|---|---|---|---|
| `deploy.ts --bundle` (default) | `dist/pi-agent/pi-agent.js` + `ext-bundles/` + `node_modules ->` bun link farm | no — same machine only | its own gate |
| `deploy.ts --snapshot` | source tree + node_modules copy | no — same machine only | its own gate |
| `deploy.ts --standalone` | `--bundle` + a copied `bun` binary | no — same machine only | nothing |
| `deploy.ts --exe` | single compiled binary + `skills/` | yes | its own gate |
| `deploy-sh.ts` | `~/proj/dist/pi-agent-sh/<version>/` — minimal core + `ext/<name>/` | yes, gated | **the real artifact** |

`dist/pi-agent` has no consumer outside `scripts/check-deploy-artifacts.sh` (the gate
that builds it), `update-pi.sh --rebuild`, and two `package.json` scripts (`dist`,
`exe`) that nothing invokes. The developer's own shell wrapper runs **source mode**
(`bun bun-apps/pi-agent/src/cli.ts`) and never touches a deploy artifact.

Three of the four legacy modes cannot leave the build machine by construction: their
`node_modules` is a symlink into `~/.bun/install/cache/links/…`. The fourth (`--exe`)
is strictly dominated by `deploy-sh`, which produces the same compiled core plus
independently rebuildable extensions, under five gates `--exe` does not have.

### Three registries for one set of extensions

- `src/static-extensions.ts` — 15 static `import`s, loaded in source mode *and* baked
  into every legacy compiled/bundled artifact.
- `run-dir/manifest.json` — five parallel arrays: `extensions[]`, `skills[]`,
  `binarySkills[]`, `staticExtensions[]`, `npmExtensions[]` (empty), plus
  `lazyExtensions{}`.
- `deploy-config.yaml` — the portable base set (12 today, obsidian + knowledge-card in
  flight on a sibling branch).

Adding one extension touches four files today; the repo's own knowledge base records
that as a recurring CI failure mode.

### Two bundlers, already drifted

`lib/build-extensions.ts` (395 lines, ESM, `THIN_EXTERNALS`) and `lib/sh-ext-build.ts`
(434 lines, CJS, `hostModules`) solve the same problem twice. `build-extensions.ts`
keeps its **own copy of the Node builtin list**, and it has already drifted from the
core's: it is missing `http2`, `constants`, `domain`, and `punycode`, and mixes bare
and `node:`-prefixed spellings (`node:tty`, `node:dns`). The core's list
(`src/sh/host-modules.ts`) is the one the runtime actually enforces, so the second copy
can only ever be wrong.

### Cost is not the motivation

Measured on this machine (bun 1.3.14, macOS arm64):

- full `deploy:sh` — **1.76 s** wall (70 MB core compile + 12 extension bundles + a
  13 MB playwright-core vendor copy)
- `scripts/check-deploy-artifacts.sh` (snapshot + exe + bundle, each built and booted)
  — **3.49 s** wall

Neither is a budget problem. The motivation is maintenance surface and drift that is
already happening.

### Storage waste is retention, not duplication

`~/proj/dist/pi-agent-sh/` holds 1.2 GB across 15 versions. Hashing every deployed
core: **11 distinct binaries across 15 versions** — deduplication would recover roughly
280 MB. The dominant cost is that nothing is ever pruned.

## Goals

1. One deploy pipeline, one artifact tree.
2. One extension registry.
3. One extension bundler.
4. Version directories that are genuinely immutable.
5. A relocatability proof that is behavioural, not a string heuristic.

## Non-goals

- Changing the runtime extension loader (`src/sh/ext-loader.ts`,
  `ext-manifest.ts`, `host-modules.ts`). That layer is correct and stays as-is.
- Changing the host-module contract or `HOST_API`.
- Deploying the machine-bound extensions (`movie-director`, `flux2`, `krea2`, `ltx`,
  `zai-mcp`, `research-tool`, `archify`, `file2md`) or the repo-internal ones
  (`devops`, `tool-gate`). They remain source-mode only — that is what
  `profiles: [local]` records.
- Replacing the cjs-bundle + injected-require packaging mechanism. Alternatives were
  considered and rejected (see "Rejected alternatives").

## Architecture

### Target layout

```
bun-apps/pi-agent/
  pi-agent.registry.yaml        # THE registry (was deploy-config.yaml)
  src/cli.ts                    # source mode  — extensions arrive as -e paths
  src/cli-sh.ts                 # deployed core — discovers ext/<name>/ at runtime
  src/sh/{host-modules,ext-loader,ext-manifest,ext-list}.ts   # unchanged

bun-apps/pi-agent-ext-devops/scripts/
  deploy.ts                     # THE deploy (was deploy-sh.ts)
  lib/{config,ext-build,fs,version,codegen,core-cache}.ts
```

`src/sh/` keeps its name: "sh" is now just the name of the loader family, and renaming
it would churn the one part of the system that is already right.

### Deletions

| path | lines | phase | why it goes |
|---|---:|:--:|---|
| `scripts/deploy.ts` | 896 | 1 | the four modes |
| `lib/build-extensions.ts` | 395 | 1 | second bundler; `extractBareSpecifiers` moves into `ext-build.ts` |
| `lib/build-extensions.test.ts` | 89 | 1 | with it |
| `lib/ext-hash.ts` | 119 | 1 | legacy-only warm-build cache |
| `lib/ext-hash.test.ts` | 73 | 1 | with it |
| `lib/deploy-target-guard.test.ts` | 154 | 1 | guards "out-dir is a free positional, so `bun run deploy /opt` deletes `/opt`" — a risk class that does not exist once `outRoot` comes from config and version dirs are derived |
| `scripts/check-deploy-artifacts.sh` | 125 | 1 | gates the deleted modes |
| `src/verify-deploy-cli.ts` | 275 | 1 | its steps 3–5 build and boot a `--bundle` deploy; steps 1–2 (`bun install`, quick tests) are `local_ci`'s job. Nothing invokes it. The `devops-verify-deploy` bin goes with it |
| `src/__tests__/e2e-extensions.test.ts` | 744 | 1a | builds a `--bundle` deploy and probes extension loading across 4 cwds; every mode it covers is being deleted |
| `src/__tests__/e2e-readonly.test.ts` | 170 | 1a | the read-only contract for bundle + snapshot. The contract itself survives on the sh deploy — see below |
| `src/__tests__/e2e-patches.test.ts` | 142 | 1a | runs every patch around `main()` inside a built bundle |
| `src/static-extensions.ts` | 132 | 2 | see §"Source mode" |
| `dist/pi-agent/` | 45 MB | 1a | no consumer |

Repointed rather than deleted: the `pi_deploy` agent tool. It spawns `scripts/deploy.ts`
and scrapes its human output with regexes; `runShDeploy` returns a typed object, so
`deploy-tool.ts` shrinks to a params→options map and `parseDeployOutput` is deleted
outright. `deploy-argv.ts` loses `DeployMode` / `buildDeployArgv`, `deploy-run.ts` loses
`assertSafeOutDir` (an arbitrary out-dir positional no longer exists), and `pi_verify`'s
tier union loses `high` / `readonly` with the `run-test.sh` tiers below.

Trimmed rather than deleted:

- `src/__tests__/e2e-harness.ts` (130) — loses `ensureBundle` / `runBundle` /
  `DEPLOY_SCRIPT`; keeps `PI_AGENT_DIR` / `REPO_ROOT` / `E2E_ENABLED`, which
  `e2e-image-agent.test.ts` and `e2e-launcher.test.ts` still import.
- `src/__tests__/e2e-launcher.test.ts` (336) — loses the `pi-agent.js alone →
  deployed (bundle)` routing cases; the source-mode routing cases stay.
- `scripts/run-test.sh` — the `high` and `readonly` tiers go (they exist to deploy
  bundle/snapshot/standalone); `quick` / `medium` / `smoke` stay.

**The read-only contract is not lost with `e2e-readonly.test.ts`.** Freeze +
foreign-cwd + zero-writes is a property of the sh deploy too, and `deploy-sh-probe-e2e.test.ts`
already boots the deployed binary offline. Phase 1a **adds** the zero-writes assertion to
that suite before deleting the old one — that is a task, not an assumption.

Roughly **3,314 lines** plus the artifact tree. Further fallout, smaller but real:

- `src/mode.ts` — `BundlerMode` loses `"bundle"`; only `source` and `binary` remain.
- `run-dir/resolve.ts` (335 lines) — `RunDirLayoutMode` collapses to `"source"`; the
  `.deploy-bundle` / `ext-bundles/` detection and its whole resolution branch go.
- `run-dir/run-context.ts` — both `mode === "bundle"` branches go.
- `src/patches/set-package-dir.ts` — the bundle `__dirname` walk-up goes.
- `package.json` — `deploy:bundle|snapshot|standalone|exe`, `dist`, `exe` scripts.
- `update-pi.sh --rebuild` — repointed at `deploy:sh`.
- docs `deploy-cwd-trust.md` (158), `deploy-readonly.md` (81),
  `deploy-single-binary.md` (276) — folded into `deploy-sh.md`, which becomes
  `docs/deploy.md`.

`docs/deploy-readonly.md`'s read-only contract is **not** dropped: the freeze
(`chmod a-w` + all per-user writes under `PI_CODING_AGENT_DIR`) is a property of the
sh deploy too and moves into `docs/deploy.md` intact.

## The registry

> **Revised 2026-08-20 (Phase 2 kickoff).** The original section below the examples
> assumed `static-extensions.ts` is deleted and its `-e` migration measured. #1739
> landed in between: `static-extensions.ts` is now GENERATED from
> `manifest.json` (`regen:static`), and Risk #1's stated mitigation — "keep
> `static-extensions.ts` as a source-mode-only file, generated from the registry" —
> is exactly what we now build. The registry schema also changed from
> `profiles: [...]` to **deploy-block-presence** (fewer fields that can disagree).

`deploy-config.yaml` is renamed and promoted to `bun-apps/pi-agent/pi-agent.registry.yaml`,
absorbing every array `manifest.json` carries. `manifest.json` becomes a **derived
artifact**, generated from the registry — it is NOT deleted, because 12 consumers
read it (including the deployed core, at runtime, through the embedded-assets
pipeline; embedding a YAML parser there to save one generated file is a bad trade).
The #1739 chain is preserved end-to-end:

```
pi-agent.registry.yaml ──(gen-manifest, Bun.YAML.parse)──▶ run-dir/manifest.json
        │                                                        │
        │                                                        └─▶ regen:static ─▶ static-extensions.ts
        └─ deploy.ts / config.ts read the registry directly (deploy blocks)
```

```yaml
hostApi: 2
hostModules: [...]                       # hard-checked against src/sh/host-modules.ts

deploy:
  outRoot: ~/proj/dist/pi-agent-sh
  version: { from: package.json, gitSha: true }
  freeze: true
  current: true

extensions:
  - name: task
    package: pi-agent-ext-task
    entry: extensions/task.ts            # package-relative; generator normalises
    load: static                         # static import (codegen) | dynamic (-e)

  - name: file2md
    load: static
    excludeReason: vendored mupdf is machine-bound

  - name: obsidian
    load: static
    skills: true                         # ships a skills dir → derived skills[]
    deploy:                              # BLOCK PRESENCE = ships in the portable tree
      order: 130
      copy: [vault-template]

  - name: movie-director
    load: dynamic                        # source mode loads it via -e
    excludeReason: bound to this machine's swift director CLIs

lazyExtensions: {}                       # unchanged mechanism, same file, own key
```

Rules the generator enforces (schema-validated, unknown keys are errors):

- `load` is `static` or `dynamic`; the derived `staticExtensions[]` is exactly the
  `load: static` set, `extensions[]` (the `-e` entries) exactly the `load: dynamic` set.
- A `deploy:` block means the extension ships; **its absence requires
  `excludeReason`**. Today that rationale lives in a prose paragraph in
  `docs/deploy.md` § Limits — text that drifts. As a required schema field, an
  extension cannot quietly fall out of the portable set without someone writing
  down why.
- `deploy.order` values are unique across the registry.
- `entry` exists on disk (relative to the package dir).
- `skills: true` is the single source for skill paths; `skills[]` and
  `binarySkills[]` are derived (`binarySkills: true` marks the 5 that the
  binary-mode patch extracts).

Dying with this change (verified dead or legacy residue): `bundleMode` (the
legacy bundler's field; only `ext-doctor` displays it), `testGate` (zero
consumers — grep finds only `manifest-types` and `ext new`'s writer),
`npmExtensions` (empty, legacy), `fullReason` (died with Phase 1a).
`lazyExtensions` survives verbatim.

**Anti-drift guards** (the effort's standing pattern):

- A freshness gate: a CI test regenerates `manifest.json` from the registry and
  byte-diffs the result — hand-editing the manifest, or editing the registry
  without regenerating, both go red.
- `manifest.json` gains an `@generated` header marker;
  `manifest-consistency.test.ts` additionally asserts the derivation invariants
  above against the registry.
- A structural guard forbids a third registry: no new file may parse
  configuration that names extensions + skills + deploy membership together.

Result: adding an extension is **one YAML entry** (then `regen:manifest` +
`regen:static` run by `ext new`), down from four files.

## Deploy pipeline hardening

### a. Content-addressed core + hardlink

Hash the core's build inputs — `bun-apps/pi-agent/src/` tree, the resolved
`@earendil-works/pi-coding-agent` version, `Bun.version`, and the codegen inputs — into
`<outRoot>/.cores/<hash>`. A version directory hardlinks that file as its `pi-agent`.

Recovers the measured ~280 MB of duplicate cores, and more importantly makes a
"nothing changed in the core" deploy free.

Interaction with `freeze`: hardlinks share an inode, so `chmod a-w` on one is `chmod
a-w` on all. Every deployed core is `a-w` anyway, so this is benign — but pruning must
`chmod u+w` the *directory*, never the core file, and must never `chmod` a core that
other version dirs still link. The prune step therefore only unlinks.

### b. Delete the `--ext <name>` in-place path

`--ext` today unfreezes an existing version directory, rebuilds selected extensions
into it, re-runs the smoke gate, and re-freezes — **mutating a released version in
place**, which defeats the versioning the pipeline exists to provide.

With (a), "only an extension changed" is just an ordinary deploy that skips the
compile. So the mode is deleted: one code path fewer, no unfreeze/refreeze dance, and
version directories become genuinely immutable.

### c. `keep: N` retention

Prune version directories oldest-first, never touching the one `current` points at, and
never dropping below `keep`. This is the actual fix for the 1.2 GB.

### d. Gate 5 — relocation smoke

Gate 4 (foreign-path scan) is a string heuristic whose own header calls it
"deliberately narrow" to avoid false positives — which means it accepts false
negatives. Replace the *proof* (not the gate; keep both) with a behavioural one: copy
the staged tree to a different absolute path and run `--ext-list` there, asserting the
same extension set loads. That is what "relocatable" actually means, and it costs about
a second.

## Source mode

> **Superseded 2026-08-20.** This section proposed deleting `static-extensions.ts` and
> moving its 15 extensions to `-e` loading — the design's single riskiest change.
> #1739 landed `static-extensions.ts` as a GENERATED file (from `manifest.json`,
> `regen:static`), which achieves the registry consolidation without touching the
> source-mode boot path at all. The `-e` migration, the `overriddenStaticExtensions`
> removal, and the `-ne` gate simplification are **dead**: the loading path stays as
> it is, and Phase 2 only changes where the data comes from. Risk #1 below is retired
> for the same reason.

## Gates and tests

- delete `scripts/check-deploy-artifacts.sh`
- rename `scripts/check-deploy-sh-e2e.sh` → `scripts/check-deploy-e2e.sh` (same
  content; it already runs the deployed binary offline)
- `.github/workflows/ci.yml.disabled` `regression-gates` job updated in the same commit
  — `local_ci` derives its gate list from that job, and `tests/ci-workflow-references.test.ts`
  guards the reference. The step must stay `if:`-free (`parseCiGates` refuses the whole
  list rather than guess at conditionals).
- `bun-apps/tests/package-scripts-runnable.test.ts` will need the removed `deploy:*`
  scripts dropped.
- the deleted second builtin list takes the drift vector with it.

Unchanged and still load-bearing: the four build gates, `dep-guard.test.ts` invariant 7
and `extension-isolation-contract.test.ts`, both of which derive the base set from the
registry file — they follow the rename, they do not change shape.

## Rejected alternatives

**Ship extensions as unbundled ESM directories.** Would remove the `__dirname` /
`import.meta.url` / dynamic-import workarounds at a stroke. Rejected: it requires each
extension's full dependency tree on disk (the bundles are 6 KB–880 KB; the trees are
tens of MB) plus TypeScript transpilation at runtime, and bare-specifier resolution
from a real path is exactly what does not work inside a compiled binary.

**One compiled binary per extension, IPC to the host.** Real isolation, and it would
make `HOST_API` unnecessary. Rejected: 70 MB per extension and a process boundary
across an API built on shared module identity (`pi-tui` overlays, the subagent
in-flight registry).

**Keep the four modes, deduplicate only the shared bundler internals.** The
conservative option. Rejected because it preserves the thing that generates the drift:
two registries, two bundlers, and five artifacts, one of which anyone runs.

## Phasing

Each phase is independently shippable, independently revertible, and green on
`local_ci` before the next starts. **Each phase gets its own implementation plan and
its own PR** — this document is the shared design, not a single unit of work.

**Phase 1 — deletion, zero behaviour change.** Split into two PRs; the blast radius is
larger than a single reviewable diff.

*1a — retire the legacy deploy pipeline.* First move the read-only assertions onto the sh
e2e suite, then delete: `scripts/deploy.ts`, `build-extensions.ts`, `ext-hash.ts`,
`deploy-target-guard.test.ts`, `check-deploy-artifacts.sh`, `verify-deploy-cli.ts` (+ its
`devops-verify-deploy` bin), the three bundle-bound e2e suites, `run-test.sh`'s `high` /
`readonly` tiers, the `deploy:*` / `dist` / `exe` package scripts, and `dist/pi-agent`.
Move `extractBareSpecifiers` into `sh-ext-build.ts` before deleting its home, and
repoint `pi_deploy` at `runShDeploy`. Repoint `update-pi.sh --rebuild` at the sh deploy.

Plan: `.planning/plans/2026-08-20-deploy-phase-1a-retire-legacy-pipeline.md`.

*1b — collapse "bundle" out of the runtime.* `mode.ts`'s `BundlerMode` loses `"bundle"`;
`resolve.ts`'s `RunDirLayoutMode` collapses to `"source"`; `run-context.ts` and
`set-package-dir.ts` lose their bundle branches; `pi-agent.sh` loses its
`pi-agent.js`-detection arm. Then the renames (`deploy-sh.ts` → `deploy.ts`,
`deploy-sh-cli.ts` → `deploy-cli.ts`, `lib/sh-*.ts` → `lib/*.ts`,
`check-deploy-sh-e2e.sh` → `check-deploy-e2e.sh`) and the docs fold into `docs/deploy.md`.

The `deploy:sh` package script keeps its name through Phase 1 (muscle memory, and it
appears in `SKILL.md` / `CLAUDE.md`); renaming it to `deploy` is a Phase 3 cleanup once
nothing else is in flight.

Nothing a user runs changes behaviour: source mode is untouched, and the sh deploy is
byte-identical apart from the script name.

**Phase 2 — one registry.** Split into two PRs.

*2a — the registry + generator.* `deploy-config.yaml` → `pi-agent.registry.yaml`
(deploy-block schema, see "The registry"), a `gen-manifest` generator
(`Bun.YAML.parse`, schema-validated) emits `run-dir/manifest.json` byte-stably, the
freshness gate + `@generated` marker + structural guard land with it, and `ext new`
writes the registry instead of the manifest. The generated `manifest.json` must be
byte-identical to the hand-maintained one minus the dead fields (`bundleMode`,
`testGate`) — anything else is a behavioural change that belongs in 2b or never.

*2b — cleanup.* Dead fields out of `manifest-types` / `ext-doctor`; docs fold;
`deploy:sh` package script renamed to `deploy` (the Phase 3 note below folds into
here); `update-pi.sh` help if affected.

No source-mode measurement gate anymore: the loading path is untouched by design.

**Phase 3 — deploy hardening.**
Content-addressed core + hardlink, delete `--ext`, `keep: N` retention, gate 5
relocation smoke.

## Risks

1. **RETIRED 2026-08-20 — moving 15 static extensions to `-e`.** #1739's codegen made
   `static-extensions.ts` a generated file, so the registry consolidation no longer
   touches the source-mode boot path. The risk this section described (behavioural
   equivalence + boot cost of `-e` loading) does not apply to Phase 2 as revised.

2. **Hardlinked cores and `freeze` (Phase 3).** Shared inode means shared mode bits.
   Benign as designed (everything is `a-w`), but a future `--no-freeze` deploy that
   reuses a cached core would make every version dir sharing that core writable. The
   core cache must therefore be keyed on, or bypassed by, `freeze: false`.

3. **Sibling worktrees.** Nine worktrees are active and at least one has uncommitted
   registry changes in flight (obsidian + knowledge-card joining the base set on
   `devops-tool-rename-and-knowledge-deploy`). Phase 2 rewrites the registry file and
   will conflict with any concurrent edit to it. Land Phase 2 only when that branch has
   merged, and re-derive the extension list from `origin/main` at that moment rather
   than from this document.

4. **`update-pi.sh --rebuild` semantics change.** It currently produces
   `dist/pi-agent`; afterwards it produces a new versioned sh deploy and moves
   `current`. That is a more consequential action than what the flag does today, and the
   flag's help text must say so.

## Verification

Every phase:

```bash
bun bun-apps/pi-agent-ext-devops/src/local-ci-cli.ts
```

Phase-specific, beyond `local_ci`:

- **Phase 1** — `bun run --cwd bun-apps/pi-agent deploy:sh --out <tmp> --no-current
  --force` succeeds and produces the same extension set as the pre-change deploy
  (`--ext-list` diff); `grep -r` finds no surviving reference to the deleted modes
  outside `.planning/` and `vaults_root/`.
- **Phase 2** — the freshness gate (regenerate `manifest.json`, byte-diff) is green on
  the committed tree and RED when the manifest or registry is hand-edited (canary);
  a full `deploy:sh` from the registry-built manifest boots the same 14-extension set;
  `bun test` for pi-agent and pi-agent-ext-devops green.
- **Phase 3** — deploy twice with no source change and assert the second run reuses the
  cached core (same inode); deploy `keep+2` times and assert the oldest dirs are gone
  and `current` still resolves; the relocation smoke as a build gate.

## What this design does not claim

- That the four legacy modes are broken today. They build and boot; `check-deploy-artifacts.sh`
  proves it in 3.49 s. The argument is that they are unused and duplicative, not defective.
- That `deploy-sh` is bug-free. Its `--ext` path mutates released versions (§b) and it
  has no retention (§c) — both are fixed here.
- That the source-mode `-e` migration works — moot: the migration was cancelled in the
  Phase 2 revision (see "Source mode").
