# Deploy architecture consolidation — one pipeline, one registry, one bundler

Date: 2026-08-20
Status: approved design (implementation not started)
Base: `origin/main` @ 782d99b8a
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
| `src/static-extensions.ts` | 132 | 2 | see §"Source mode" |
| `dist/pi-agent/` | 45 MB | 1 | no consumer |

Roughly **2,258 lines** plus the artifact tree. Further fallout, smaller but real:

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

`deploy-config.yaml` → `pi-agent.registry.yaml`, absorbing `manifest.json`'s
`extensions[]`, `skills[]`, `binarySkills[]`, `staticExtensions[]`, `npmExtensions[]`.

```yaml
hostApi: 2
hostModules:                             # hard-checked against src/sh/host-modules.ts
  - "@earendil-works/pi-coding-agent"
  # …

deploy:
  outRoot: ~/proj/dist/pi-agent-sh
  version: { from: package.json, gitSha: true }
  freeze: true
  current: true
  keep: 5                                # NEW — retention

extensions:
  - name: task
    package: pi-agent-ext-task
    entry: extensions/task.ts
    order: 10
    profiles: [portable, local]          # the one new field

  - name: web-access
    package: pi-agent-ext-web-access
    entry: extensions/web-access.ts
    order: 90
    profiles: [portable, local]
    skills: [skills]
    vendor: [unpdf]

  - name: movie-director
    package: pi-agent-ext-movie-director
    entry: extensions/movie-director.ts
    order: 500
    profiles: [local]
    excludeReason: bound to this machine's swift director CLIs
    testGate: bun test --cwd bun-apps/pi-agent-ext-movie-director

lazyExtensions:                          # unchanged mechanism, same file, own key
  workflow: pi-agent-ext-workflow/extensions/workflow.ts
```

Rules the parser enforces (it is already strict — unknown keys are errors):

- `profiles` is required and non-empty; known values are `portable` and `local`.
- `portable` implies `local` (anything shipped must also load in source mode) — the
  parser normalises rather than requiring both to be typed.
- An extension **not** in `portable` MUST declare `excludeReason`. This is the point of
  the field: today the exclusion rationale lives in a prose paragraph in
  `docs/deploy-sh.md` § Limits, which is exactly the kind of text that drifts. Making
  it a required schema field means an extension cannot quietly fall out of the portable
  set without someone writing down why.
- `skills:` is the single source for skill paths. `manifest.json`'s separate `skills[]`
  and `binarySkills[]` arrays are derived, not restated.

Dying with legacy: `bundleMode` (thin/full), `fullReason`, `binarySkills`,
`npmExtensions`, `staticExtensions`. `testGate` survives (read by `ext-doctor` and a
consistency test). `lazyExtensions` survives — bare-alias `-e workflow` back-compat is
a different job from registration, and 20+ scripts still pass those aliases.

Result: adding an extension is **one YAML entry**, down from four files.

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

`cli.ts` drops the `STATIC_EXTENSION_FACTORIES` dynamic import, `overriddenStaticExtensions`,
and its hand-rolled `-ne` gate — roughly 40 lines. Extensions arrive as `-e <abs>` paths
spliced by the run-dir patch, exactly as the 8 manifest-declared extensions already do.

Three things stop being needed, not merely move:

- **`-e` override handling.** `overriddenStaticExtensions` exists because a user `-e`
  pointing into a static package's directory registers the same tool names twice and pi
  crashes with `Tool conflicts`. Upstream pi dedups `-e` against `-e` by resolved path;
  the conflict class only exists because two different registration paths coexist.
- **The custom `-ne` gate.** Upstream never gates `extensionFactories` on `-ne`, which
  is why cli.ts had to. With no factories, `-ne` is upstream's job again.
- **The load-order comment block.** The static import had to sit below the `cli`
  intercept and below `applyPatches()` because evaluating 15 extension entry graphs has
  import-time side effects (webui imports `pi-coding-agent` undeclared, resolvable only
  after `ensure-extension-deps` runs). No static import, no ordering hazard.

`static-extensions.ts` exists because only a literal `import` survives
`bun build --compile`. After Phase 1 the only compile target is `cli-sh.ts`, which
imports zero extensions. The reason is gone.

**This is the riskiest part of the design, and it is unverified.** See "Risks".

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

**Phase 1 — deletion, zero behaviour change.**
Delete the four modes, `build-extensions.ts`, `ext-hash.ts`, `deploy-target-guard.test.ts`,
`check-deploy-artifacts.sh`, `verify-deploy-cli.ts` (+ its `devops-verify-deploy` bin),
`dist/pi-agent`, the `deploy:*` / `dist` / `exe` scripts. Rename `deploy-sh.ts` →
`deploy.ts`, `deploy-sh-cli.ts` → `deploy-cli.ts`, and `lib/sh-*.ts` → `lib/*.ts`.
Repoint `update-pi.sh --rebuild` at the sh deploy. Collapse `mode.ts` / `resolve.ts` /
`run-context.ts` / `set-package-dir.ts` bundle branches. Fold the three legacy docs into
`docs/deploy.md`.

The `deploy:sh` package script keeps its name through Phase 1 (muscle memory, and it
appears in `SKILL.md` / `CLAUDE.md`); renaming it to `deploy` is a Phase 3 cleanup once
nothing else is in flight.

Nothing a user runs changes behaviour: source mode is untouched, and the sh deploy is
byte-identical apart from the script name.

**Phase 2 — one registry.**
`deploy-config.yaml` → `pi-agent.registry.yaml` with `profiles:` / `excludeReason:`.
Absorb `manifest.json`'s five arrays. Delete `static-extensions.ts` and simplify
`cli.ts`. Update `dep-guard` / `extension-isolation-contract` to the new path.

Gated on a measurement, not a guess: **source-mode boot time and loaded-extension set
before and after must match**, captured as a test, not a one-off observation.

**Phase 3 — deploy hardening.**
Content-addressed core + hardlink, delete `--ext`, `keep: N` retention, gate 5
relocation smoke.

## Risks

1. **Moving 15 static extensions to `-e` in source mode (Phase 2).** The highest-risk
   change in this design. Unverified today: behavioural equivalence and boot cost. The
   mechanism should work — the `ensure-extension-deps` patch already makes Bun natively
   import extension `.ts` graphs, so jiti's `try-native` succeeds and no transform
   happens, which is the same path the 8 manifest extensions take. But "should" is not
   "does". Phase 2 starts by measuring both, and stops if either regresses.
   Mitigation if it does: keep `static-extensions.ts` as a source-mode-only file,
   generated from the registry rather than hand-maintained. That still collapses the
   registries; it just keeps the loading path.

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
- **Phase 2** — a test asserting source-mode `--ext-list`-equivalent output (loaded
  extension names, sorted) is unchanged, plus a recorded boot-time delta.
- **Phase 3** — deploy twice with no source change and assert the second run reuses the
  cached core (same inode); deploy `keep+2` times and assert the oldest dirs are gone
  and `current` still resolves; the relocation smoke as a build gate.

## What this design does not claim

- That the four legacy modes are broken today. They build and boot; `check-deploy-artifacts.sh`
  proves it in 3.49 s. The argument is that they are unused and duplicative, not defective.
- That `deploy-sh` is bug-free. Its `--ext` path mutates released versions (§b) and it
  has no retention (§c) — both are fixed here.
- That the source-mode `-e` migration works. It is measured in Phase 2, not assumed.
