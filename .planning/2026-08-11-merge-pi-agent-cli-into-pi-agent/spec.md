# Spec — Merge `pi-agent-cli` into `pi-agent`

**Date:** 2026-08-11
**Status:** approved (design), ready for implementation planning
**Scope:** collapse the `@repo/pi-agent-cli` workspace package into `@repo/pi-agent`
as a `cli` sub-command namespace. Packaging merge only — no feature is removed.

## Goal

One npm package, one binary, one deploy pipeline. The non-interactive CLI becomes
`pi-agent cli <command>`; `bun-apps/pi-agent-cli/` is deleted outright.

The CLI's reason to exist is **direct tool execution with a curated per-command
toolset** — an agent run that reaches one tool without the TUI and without the
full run-dir extension manifest. That property must survive the merge intact.

## Constraints

1. **`pi-agent` / `./pi-agent.sh` must not break.** Every existing argv shape —
   bare TUI, `-p`, `--list-models`, `-e`, `-ne`/`-ns`, `doctor`, `ext doctor`,
   `--upgrade`, and all four deploy-layout detections in `run.sh` — behaves
   byte-identically after the merge. The single accepted behavior change is
   `./pi-agent.sh cli …` (today: launches the TUI with `cli` as the initial
   prompt; after: enters the CLI). This is the same trade-off the existing
   `doctor` / `ext doctor` intercepts already made.
2. **`pi-agent-cli` may break freely.** The package, its `bin`, its
   `dist/pi-agent-cli/` artifact, and the path `bun-apps/pi-agent-cli/src/cli.ts`
   all cease to exist. No forwarding shim.
3. **Minimal change to the `pi-agent-*` extension architecture.** Exactly one
   extension package is touched (`pi-agent-ext-subagent`, one line + one test);
   every `extensions/cli-subcommand.ts` stays byte-identical.
4. **No feature loss.** All 13 agent commands, 5 pipelines, 10 extension-backed
   sub-commands, the workflow-pack runner, the meta commands, and the build
   pipeline's obfuscation tier all survive.

## Background: what the two packages actually are

| | `pi-agent` | `pi-agent-cli` |
|---|---|---|
| Execution model | interactive TUI; official `main()` + reversible monkey-patches | non-interactive run; one process, no session loop |
| Extension loading | `run-dir/manifest.json` (eager) + `STATIC_EXTENSION_FACTORIES` (13, static) | baked-in factories, **curated per command** (ADR 0001) |
| Entry | `src/cli.ts`, reached via `run.sh` / `./pi-agent.sh` | `src/cli.ts`, reached via `bun bun-apps/pi-agent-cli/src/cli.ts` |
| Build | `scripts/deploy.ts` — 4 modes, THIN ext bundles, warm hash cache, read-only freeze | `scripts/build.ts` — minify / obfuscate / compile |
| Size | ~3.1k LOC (src + run-dir + deploy) | ~8.5k LOC src, 33 src files, 29 test files |

**Key finding that makes this merge cheap:** `pi-agent/src/static-extensions.ts`
already statically imports 13 extensions via relative paths (`../../pi-agent-ext-*`),
including obsidian, knowledge-card, file2md, workflow and power-tool; the run-dir
manifest adds flux2, krea2, ltx, movie-director and research-tool. **Every
extension `pi-agent-cli` depends on is already loaded by `pi-agent` today.** The
relative-path imports bypass `package.json`, which is why `pi-agent` declares only
6 workspace deps. Merging therefore *declares* dependencies that already exist at
the source level; it does not pull in a single new package.

There is no dependency cycle risk: no `pi-agent-ext-*` package depends on
`@repo/pi-agent`.

## Design

### Approach: pre-patch intercept + lazy subtree

`pi-agent/src/cli.ts` gains a third argv intercept, sitting beside the existing
`doctor` / `ext doctor` ones and **before `applyPatches()`**:

```ts
const argv = process.argv.slice(2);
if (isDoctorCommand(argv))    { /* existing */ }
if (isExtDoctorCommand(argv)) { /* existing */ }
if (isCliCommand(argv)) {                       // NEW: argv[0] === "cli"
  const { runCli } = await import("./cli/dispatch.ts");
  process.exit(await runCli(argv.slice(1)));
}
await applyPatches();                            // everything below unchanged
```

Two properties follow from the placement:

- **The TUI never pays for the CLI.** The dynamic import is never evaluated on
  the TUI path, so the extension `cli-subcommand.ts` specs (which statically pull
  flux2 / krea2 / ltx / movie-director) never enter the TUI process.
- **The CLI never pays for the TUI.** Intercepting before `applyPatches()` means
  no run-dir argv splice, no `pre-load-providers` patch, no
  `STATIC_EXTENSION_FACTORIES`. ADR 0001's per-command curation is preserved
  exactly, which is the whole point of the CLI.

`isCliCommand` lives in `src/cli-argv.ts` next to `isDoctorCommand`, with the same
contract and the same unit test: **only `argv[0]` matches**, never a token
appearing later in argv, so `-p "cli"` is not hijacked.

Rejected alternatives:

- *Unify session building* (delete `sessions/shared.ts`, reuse
  `STATIC_EXTENSION_FACTORIES`): overturns ADR 0001. Every `zk-*` / `file2md`
  invocation would carry 13 extensions' tool schemas. Contradicts the
  "direct tool execution" goal. Kept in reserve if a concrete need appears.
- *CLI dispatcher as the outer shell* (TUI becomes a fallback branch): forces
  `applyPatches()` after argv parsing. Patch ordering (`pre-load-providers`
  before `ModelRuntime.create`; run-dir splice before `main()`) is the most
  fragile part of `pi-agent`. Not worth disturbing for symmetry.

### Namespace token

`cli`. Chosen over `run` because the CLI already has a `workflow run <pack>`
sub-command, and `pi-agent run workflow run <pack>` reads ambiguously.

```
pi-agent                                        → TUI
pi-agent -p "hi"                                → pi print mode
pi-agent doctor                                 → deploy doctor        (unchanged)
pi-agent ext doctor                             → per-extension doctor (unchanged)
pi-agent cli zk-ask "what?"                     → CLI agent command
pi-agent cli flux2 red cube                     → extension sub-command
pi-agent cli pipeline pdf-to-vault paper.pdf    → pipeline
pi-agent cli workflow run closed-loop-proof     → headless workflow pack
pi-agent cli doctor                             → cross-machine doctor
```

The two `doctor`s coexist by namespace: `pi-agent doctor` checks deploy-mode and
patch health; `pi-agent cli doctor` checks fresh-machine portability (vault, MLX
dirs, flux2 binary, LM Studio).

### File layout

```
bun-apps/pi-agent/
├── src/
│   ├── cli.ts                  ← +1 intercept branch, nothing else
│   ├── cli-argv.ts             ← +isCliCommand
│   ├── cli/                    ← NEW: all of pi-agent-cli/src/**
│   │   ├── dispatch.ts         ← was cli.ts; exports runCli(argv): Promise<number>
│   │   ├── args.ts  flag-spec.ts
│   │   ├── commands/           (23 files)
│   │   ├── sessions/           (4 files)
│   │   ├── extensions/         (3 files)
│   │   └── __tests__/          ← src/__tests__/ + tests/ merged (29 files)
│   ├── patches/  doctor.ts  static-extensions.ts  …   ← untouched
├── workflows/                  ← was pi-agent-cli/workflows/
├── baselines/                  ← schema-cost-baseline.json, error-rate-root-cause.md
└── docs/adr/0001…0008          ← the CLI's 8 ADRs (pi-agent has no docs/adr/ today)
```

`dispatch.ts` differs from the old `cli.ts` in exactly two ways: the
`if (import.meta.main)` block is removed, and `main()` becomes
`export async function runCli(argv: string[]): Promise<number>` returning an exit
code instead of calling `process.exit`.

Moving `workflows/` is safe: `workflow-pack.ts`'s tier-5 resolution globs
`bun-apps/<pkg>/workflows` for any `<pkg>`, not a hardcoded `pi-agent-cli`.

### package.json

- Add the 10 workspace deps that are already imported but undeclared: `workflow`,
  `flux2`, `krea2`, `ltx`, `movie-director`, `power-tool`, `research-tool`,
  `knowledge-card`, `obsidian`, `file2md`. (`web-access` is already declared.)
- Add `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai` (pinned to the same
  exact version as the other three `@earendil-works/*` packages — `update-pi.sh`
  upgrades all four in lockstep), and `typebox`.
- Add `javascript-obfuscator` to `devDependencies`.
- Remove the `@repo/pi-agent` self-dependency. Two import sites become local:
  `src/cli/sessions/shared.ts`'s `registerAllProviders` and
  `src/cli/commands/doctor.ts`'s `isFailing` / `CheckStatus` / `CheckResult`.
  ADR 0005's "one provider catalog" becomes an intra-package invariant — stronger
  than the cross-package version it replaces.
- Carry over the CLI's `postinstall` (ensures `pi-agent-ext-workflow/dist/` exists).
- Script-name collisions (`cli`, `list`, `test`, `typecheck`, `dist`, `exe`):
  `pi-agent`'s win. The CLI's `zk-extract` / `zk-card` / `zk-ask` shortcut scripts
  are dropped — `bun src/cli.ts cli zk-ask …` covers them.

### tsconfig

Adopt `pi-agent`'s as-is (it already has `include: ["src/**/*.ts",
"run-dir/**/*.ts"]` and `types: ["bun", "@repo/pi-agent-ext-core-interface"]`).
The CLI's extra strictness (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`,
`noImplicitOverride`, `noFallthroughCasesInSwitch`) is **not** adopted in this
change: relaxing never breaks compilation, but tightening would mix an unrelated
batch of type errors into a move-only PR. Tightening is a separate follow-up.

### Subagent self-invocation

`pi-agent-ext-subagent/src/spawn-subagent-subprocess.ts:94`'s `getPiInvocation()`
re-invokes the parent's own entry via `process.argv[1]`. After the merge:

- Parent is the TUI → child argv is unchanged from today. No action needed.
- Parent is the CLI (`pi-agent cli zk-extract`) → `argv[1]` is still
  `pi-agent/src/cli.ts`, so the child would land on **root** (TUI print mode +
  13 static factories + run-dir manifest) instead of the CLI's lean passthrough.
  It would not crash — `overriddenStaticExtensions()` drops the static obsidian
  factory when the child passes `-e <obsidian path>`, so no tool-name conflict —
  but every distill subagent would carry the full tool-schema payload, and
  ADR 0002 (the binary is its own sub-agent target) would silently stop holding.

**Fix:** `runCli()` sets `process.env.PI_SELF_ENTRY_PREFIX = "cli"` on entry;
`getPiInvocation()` reads it and splices it ahead of `extra` in the child argv.
One line plus one unit test in `pi-agent-ext-subagent`. The env var name is
generic (not `pi-agent`-specific), so the extension stays host-agnostic and
dep-guard rule 5 continues to hold.

### Build and deploy

`scripts/build.ts` is deleted; `scripts/deploy.ts` absorbs its one unique
capability:

- `--obfuscate` joins `KNOWN_FLAGS`. `stageObfuscate()` moves over verbatim,
  including `regexObfuscation: false` and the comment explaining why (obsidian's
  wiki-link / frontmatter regexes have crashed `javascript-obfuscator`).
- Stage order, made explicit because `deploy.ts --exe` currently skips the bundle
  stage and compiles `src/cli.ts` directly:
  - `--bundle` / `--standalone` **+ `--obfuscate`**: obfuscate the emitted
    `pi-agent.js` in place, after the bundle stage.
  - `--exe` **+ `--obfuscate`**: run the bundle stage first, obfuscate its output,
    then `bun build --compile` that obfuscated bundle instead of `src/cli.ts`.
    This mirrors `build.ts`'s `--all` (`input = DO_OBFUSCATE ? OUTFILE : ENTRY`)
    and is the one place where `--obfuscate` changes `--exe`'s existing pipeline.
  - `--snapshot` **+ `--obfuscate`**: rejected with a clear error (a snapshot is a
    raw source copy; there is nothing to obfuscate).
- `dist/pi-agent-cli/` disappears. The CLI's executable is `dist/pi-agent/pi-agent`.

**Verification item that must not be assumed:** `--exe` runs
`bun build --compile src/cli.ts`. The CLI branch is a literal-specifier dynamic
`import()`. Bun's bundler normally embeds those as `$bunfs` chunks, but
`static-extensions.ts` documents a related trap (a literal `require()` survives
bundling as a real runtime call and crashes the compiled binary). The plan must
include an explicit check that `dist/pi-agent/pi-agent cli version` works in the
compiled binary. Fallback if it does not: statically import the CLI subtree from
`src/cli.ts` and branch on it, accepting the TUI import-cost regression. This is
the last resort, not the default.

Consequence: the `--exe` binary grows — the CLI's own compiled binary was
previously ~71 MB, and the merged binary carries both graphs.

### External references to update

Nine files outside the deleted package:

| File | Change |
|---|---|
| `scripts/verify-deploy.sh:63-87` | drop the separate cli test/build/bundle steps; add a `pi-agent cli version` smoke. **Also fixes a pre-existing bug**: step 3a runs `bun-apps/pi-agent/scripts/build.ts`, which does not exist (pi-agent has only `deploy.ts`) — the script is already broken at that line today |
| `scripts/iter4-measure.mjs:90` | `--cwd` + `cli` prefix |
| `scripts/live-zk-ask-measure.mjs:44` | `CLI_DIR` |
| `bun-apps/pi-agent/run-dir/workflows/verify-bun-pi-agent-cli.js:29` | `cliPkg` default |
| `bun-apps/pi-agent/run-test.sh:227` | pkg list |
| `bun-apps/pi-agent-ext-devops/src/schema-cost-check.ts:80,134` | CLI path + `cli` token |
| `bun-apps/pi-agent-ext-workflow/tests/workflow-pack.test.ts:529` | `CLI_WORKFLOWS` — a **real** path to the `echo` / `args-demo` / `sample` example packs; breaks hard |
| `bun-apps/pi-agent-ext-workflow/tests/workflow-pack.test.ts:635,641` | a tmpdir-synthesized `bun-apps/pi-agent-cli/workflows` + its `row.source` assertion; cosmetic, rename both together |
| `bun-apps/tests/dep-guard.test.ts:146` | rule 5's host name → `pi-agent` |
| `docs/benchmarks/verify-bun-pi-agent-cli/compare.ts` | invocation path |

Plus `bun-apps/bun.lock` (regenerated by `bun install` from `bun-apps/`), the
moved workflow scripts' own `--cwd .../pi-agent-cli` strings
(`knowledge-distill.js`, `retrieval-quality-self-improve.js`, three
`manifest.json` `howToRun` fields), and `CLAUDE.md`'s two pointers
(`pi-agent-cli/src/commands/schema-cost.ts` and
`pi-agent-cli/src/extensions/registry.ts`).

`.planning/` history files keep their old paths — they are dated snapshots, not
live references.

### Documentation

`pi-agent/CONTEXT.md` gains a "Non-interactive CLI" section absorbing
`pi-agent-cli/CONTEXT.md`'s vocabulary (non-interactive run, single-turn agent
run, baked-in / always-on / per-command extension, command / pipeline / workflow
sub-command / workflow pack / meta command / passthrough / sub-agent target,
plus the distill and retrieval terms). One domain, one `CONTEXT.md`, per
`docs/agents/domain.md`. The 8 ADRs move to `pi-agent/docs/adr/` unedited except
where they name the old package path.

## Testing

The 29 CLI test files move to `src/cli/__tests__/`, joining `pi-agent`'s 30, so
`bun run --cwd bun-apps/pi-agent test` runs both suites.

Changes required inside the moved tests:

- e2e helpers (`__tests__/e2e/_helpers.ts`) spawn `pi-agent/src/cli.ts` with a
  `cli` prefix.
- `boot-smoke.baseline.json` does **not** change. It records tool-graph facts
  (`toolCountFloor: 50`, `sourceMinimum`, `expectedErrorSources`,
  `expectedContractFailures`), and those come from
  `discoverExtensionEntries()`, which derives its list from
  `bun-apps/pi-agent/run-dir/manifest.json` located via a `resolveRepoRoot()`
  walk-up. Neither the manifest nor the walk-up is affected by moving the
  source file deeper. Only the test's spawn cwd + the `cli` argv prefix change.
- `schema-cost.test.ts`'s `resolveRepoRoot(import.meta.dir)` assertion is
  depth-independent (it walks up until it finds `bun-apps/`) and needs no edit.

New test:

- `isCliCommand` matches only `argv[0]`; `-p "cli"` and `--append-system-prompt
  cli` are not hijacked. Same shape as the existing `isDoctorCommand` test.

## Acceptance criteria

All of these must pass before the change is complete:

```
bun install                                     # from bun-apps/
bun run --cwd bun-apps/pi-agent test            # both suites green
bun run --cwd bun-apps/pi-agent typecheck
( cd bun-apps/pi-agent-ext-workflow && bun test )   # workflow-pack source assertion
( cd bun-apps && bun test tests/dep-guard.test.ts )
./pi-agent.sh --list-models                     # unchanged behavior
./pi-agent.sh doctor
./pi-agent.sh ext doctor
./pi-agent.sh cli version
./pi-agent.sh cli doctor
bun run --cwd bun-apps/pi-agent deploy:exe
dist/pi-agent/pi-agent doctor --smoke
dist/pi-agent/pi-agent cli version              # proves the dynamic import is in $bunfs
bash scripts/verify-deploy.sh
```

Plus: `bun-apps/pi-agent-cli/` does not exist, and no live (non-`.planning`) file
references it.

## Out of scope

- Pruning the CLI's command surface. Everything is preserved.
- Unifying session construction (the rejected "approach B"). Revisit only if a
  concrete need appears.
- Adopting the CLI's stricter tsconfig flags in `pi-agent`.
- Any change to `run.sh` / `pi-agent.sh`, `update-pi.sh`, the patch set,
  `run-dir/resolve.ts`, or the deploy mode-detection logic.
