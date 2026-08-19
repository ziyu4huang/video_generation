# deploy-sh — versioned minimal-core deploy

A second, independent deploy pipeline. It builds a **minimal `pi-agent` executable with zero
extensions compiled in**, plus **extension packages built separately** into `ext/<name>/`, all
under a versioned directory. The core discovers extensions at runtime; delete `ext/` and it still
boots, just without them.

This pipeline does not touch the four modes in `../pi-agent-ext-devops/scripts/deploy.ts`
(`--bundle` / `--snapshot` / `--standalone` / `--exe`), which keep working exactly as before.

## Layout

```
~/proj/dist/pi-agent-sh/
  current -> 0.1.0+g520acb9/          # flipped only after every gate passes
  0.1.0+g520acb9/
    pi-agent            # compiled minimal core (~70 MB)
    run.sh              # launcher: env hardening + exec ./pi-agent
    deploy.json         # provenance: version, builtAt, git sha, bun version, config snapshot
    ext/
      task/       ext.json  ext.cjs                    (~155 KB)
      power-tool/ ext.json  ext.cjs  skills/…          (~73 KB)
```

Version string: `<pi-agent package.json version>+g<git short sha>`. The executable locates its own
tree via `dirname(process.execPath)` — no repo path is baked in.

## Commands

```bash
bun run --cwd bun-apps/pi-agent deploy:sh                  # full deploy
bun run --cwd bun-apps/pi-agent deploy:sh --ext power-tool # rebuild ONE extension in place
bun run --cwd bun-apps/pi-agent deploy:sh --list           # versions + current target
~/proj/dist/pi-agent-sh/current/run.sh                     # run it
~/proj/dist/pi-agent-sh/current/pi-agent --ext-list        # what loaded, what was skipped, and why
```

Other flags: `--config <path>`, `--out <dir>`, `--version <str>`, `--force`, `--no-freeze`,
`--no-current`. stdout is pure JSON; exit 0 = ok, 1 = failure, 2 = usage error.

`--ext` requires the version dir to already exist: it unfreezes that tree, rebuilds only the named
extensions, re-runs the smoke gate, and re-freezes. Changing one extension does not recompile the
core.

## The host contract

Extension bundles are built `--format=cjs` with pi's runtime marked `--external`, and the core
evaluates each bundle with an injected `require` that serves **its own embedded modules**.

This is not a packaging preference. A bundle that resolves `@earendil-works/pi-tui` from disk gets a
*different module instance* than the one inside the binary (measured: identity check `false`; with
host injection, `true`). `pi-agent-ext-task` builds TUI overlays and keybindings against the host's
running pi-tui, so a second instance breaks identity-sensitive behavior.

Host modules (`src/sh/host-modules.ts`, `HOST_MODULE_IDS`):

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`, `typebox/value`
- `@repo/pi-agent-core-runtime` — holds cross-extension singletons (`SubagentInFlightRegistry`);
  inlining it per-extension would split the singleton

Node/Bun builtins are also served by the injected require. That is required, not a convenience: a
minified bundle calls `require("module")` / `require("child_process")` for its own interop shims
even when the extension source never mentions them.

**Adding a host module means editing two files** — `src/sh/host-modules.ts` (a static
`import * as`, so the compiler embeds it) and `deploy-config.yaml`. The deploy hard-fails when the
two disagree, because a config that promises a module the core does not embed produces extensions
that silently refuse to load.

`hostApi` (currently `1`) is the contract version. Every `ext.json` records the version it was built
against; a mismatch skips that extension with a warning instead of half-loading it.

## Adding an extension

Add an entry to `deploy-config.yaml`:

```yaml
  - name: my-ext
    package: pi-agent-ext-my-ext
    entry: extensions/my-ext.ts
    order: 60
    skills: [skills]        # optional
```

then run `deploy:sh`. If the build reports foreign specifiers, decide per specifier: a shared
runtime that must be identical to the host's goes in the host whitelist; anything else should be
inlined by the bundler (check the package declares it in its own `package.json` and that
`bun install` has run from `bun-apps/`).

`order` controls load order (ascending, ties broken by name): `task` = 10, `power-tool` = 50.

## The three gates

Every deploy runs these; any failure aborts, removes the staging dir, and leaves `current` untouched.

1. **Foreign-specifier scan** — bare specifiers left in a bundle must be a subset of the host
   whitelist plus builtins. A failure means the extension would look fine on disk and fail to load
   on the user's machine.
2. **Load probe** — the freshly built `ext.cjs` is loaded through the *real* loader with the *real*
   host modules. This is what catches a change in bun's cjs output shape at deploy time rather than
   at user runtime. (It resolves host modules with `Bun.resolveSync` from `bun-apps/pi-agent`: the
   workspace's isolated linker keeps them in the global store, where a plain `createRequire` from
   the output dir cannot reach them — an earlier version resolved from there, stubbed everything,
   and proved nothing while passing.)
3. **Dual-state smoke** — `pi-agent --ext-list` must report every configured extension loaded; then
   `ext/` is moved aside and the same command must exit 0 with zero extensions. This is the
   executable proof that the core does not depend on its extensions.

## Limits

- MVP ships `task` and `power-tool` only. The other 12 extensions in `src/static-extensions.ts` are
  still available through the legacy modes; each needs its own assets/skills/native-dep review
  before it can move (`hermes-memory` sqlite, `webui` static assets, `superpowers` skills tree).
- No automatic cleanup of old version directories — `current` plus version dirs, nothing else.
- Same-machine assumption is unchanged from the legacy modes for the *build*; the deployed tree
  itself carries no repo paths.
