# Deploy packaging: repo-independent pi-agent, any cwd

How `scripts/deploy.ts` + `run-dir/resolve.ts` produce a pi-agent dir that runs
from **any** cwd, independent of a repo checkout (same machine). Note: only
`--exe` is fully self-contained/portable — Bundle/Standalone/Snapshot all
resolve `node_modules` through the machine-global bun store, so they are
same-machine only. See
[README.md § Build / Deploy modes](../README.md#build--deploy-modes) for the
canonical quick-command table; this doc is the deeper layout + resolution
reference (`resolve.ts` mode detection, `-ne` layering, per-mode directory
tree). [`deploy-single-binary.md`](./deploy-single-binary.md) covers `--exe`
specifically; [`deploy-readonly.md`](./deploy-readonly.md) covers the
read-only freeze contract.

## The gap `deploy.ts` closes

A raw `bun src/cli.ts` (or the default-mode bundle) resolves its extension set
from the **repo's** `bun-apps/` (baked into `src/generated/run-dir-base.ts` at
build time for bundle mode). So it only runs where that repo path exists.
`deploy.ts` copies/bundles the extension packages INTO the output dir, and
`resolve.ts`'s deploy-mode branch resolves from there — so the result runs
anywhere (same machine), no checkout required.

## The four deploy modes (`deploy.ts <flags>`)

| Mode | flag | what ships | resolve.ts layout | `bun install`? |
|---|---|---|---|---|
| **Bundle** (default) | *(none)* | pre-bundled `ext-bundles/*.thin.js` + symlinked node_modules | `.deploy-bundle` + `ext-bundles/` → **deploy-bundle** | no (symlink) |
| **Standalone** | `--standalone` | same as Bundle **+** a copied `bun` binary (no system bun needed) | same as Bundle → **deploy-bundle** | no (symlink) |
| **Snapshot** | `--snapshot` | raw `pi-agent/` + every sibling extension package dir, verbatim source, no bundling | no markers → **source** (see caveat below) | no (node_modules copied — symlinks into global store preserved, same-machine only) |
| **Exe** | `--exe` | single compiled executable, static extension set + theme/skills/assets embedded | binary (`$bunfs` scheme, not a run-dir layout) | n/a |

### resolve.ts layout detection (marker-based)

`detectRunDirMode(selfDir)` checks, in precedence order:

1. `.deploy-bundle` marker **+** `ext-bundles/` dir → **deploy-bundle** (Bundle + Standalone)
2. `packages/` dir **+** `run-dir/manifest.json` → **deploy-package** (no current deploy.ts
   mode produces this layout — kept for forward-compat / hand-built layouts, otherwise dead code)
3. otherwise → **source** (repo source, a plain in-repo bundle, **and Snapshot**)

Binary mode (`--exe`) is detected separately, via `src/mode.ts`'s `$bunfs`
scheme check — it's never a run-dir layout at all.

### Why Bundle/Standalone use `-ne` but Snapshot doesn't

`resource-loader.js` does `noExtensions ? cliPaths : merge(cliPaths, settingsPaths)`.

- Source resolves extensions from `bun-apps/<pkg>/…` — the **same** canonical
  paths a repo `.pi/` would declare → pi dedupes them → additive layering with
  `.pi/` + `~/.pi/` is safe.
- Bundle/Standalone resolve from `ext-bundles/*.js` — **different** paths than
  a repo declaring the same extensions. Without `-ne`, running the deploy
  inside such a repo loads both sets → `Tool "X" conflicts`. So these two modes
  prepend `-ne`: pi loads ONLY the deploy's `-e` paths, ignoring `<cwd>/.pi/`.
  This is the bug that bit twice; `-ne` is the fix.
- **Snapshot is the one exception, and it's a real caveat, not an oversight**:
  because it ships raw unbundled `.ts` and resolve.ts's own module URL still
  contains `/run-dir/`, `src/mode.ts` classifies it as `mode === "source"` —
  the SAME code path plain `bun src/cli.ts` takes, additive layering and all.
  Confirmed empirically (`BUN_PI_DEBUG_RUN_DIR=1 ./run.sh --help`): a Bundle
  deploy's resolved argv contains `-ne`; a Snapshot deploy's does not. Running
  a `--snapshot` deploy from inside another repo that declares the same
  extensions via its own `.pi/` can hit the exact `Tool "X" conflicts` bug
  `-ne` exists to prevent. Prefer Bundle/Standalone/Exe when isolation from
  the invocation cwd's own `.pi/` matters; Snapshot is for same-repo-tree
  redistribution (e.g. a versioned working copy), not cwd isolation.

`-e` is `temporary` scope = trust-free + cwd-independent in all modes.

## What deploy.ts produces

### Bundle (default)

```
<outdir>/
├── pi-agent.js            # bundle
├── ext-bundles/*.thin.js  # pre-bundled extensions (THIN — shared deps external)
├── skills/<dir>/          # copied skill dirs (manifest.skills)
├── run-dir/manifest.json  # compat/debug (resolve.ts uses dir listings, not this)
├── node_modules           # symlink → pi deps store (pi-agent.js peer-dep resolution)
├── .deploy-bundle         # marker — resolve.ts deploy-bundle detection
├── package.json           # minimal {name,private,type} — NO workspaces
└── run.sh                 # layout-aware launcher
```

### Standalone (`--standalone`)

Same as Bundle, plus a copied `bun` binary at `<outdir>/bun` — `run.sh` invokes
`./bun run pi-agent.js` instead of the system `bun`, so the target machine
needs no bun install at all.

### Snapshot (`--snapshot`)

```
<outdir>/
├── pi-agent/…                      # verbatim copy of bun-apps/pi-agent/
├── <ext-pkg>/…                     # verbatim copy of every sibling package the
│                                    #   manifest/static-extensions reference
│                                    #   (collectRequiredPkgDirs() in deploy.ts)
├── node_modules/                   # verbatim copy of bun-apps/node_modules —
│                                    #   isolated-linker symlinks preserved as-is
│                                    #   (same-machine only: symlink targets are
│                                    #   absolute paths into the global store)
└── run.sh                          # → `bun pi-agent/src/cli.ts`
```

No bundling at all — raw `.ts`, loaded by jiti at runtime same as a plain
source checkout. See the `-ne` caveat above.

### Exe (`--exe`)

A single compiled executable — see
[`deploy-single-binary.md`](deploy-single-binary.md) for the full mechanism
(static extension imports, embedded theme/skills/assets, runtime extraction).

## `run.sh` — one layout-aware launcher

Copied into every non-Exe package (Exe ships no run.sh — the compiled binary
IS the entry). Picks its entry by what's present:

| detected | gate | entry |
|---|---|---|
| Bundle / Standalone | `.deploy-bundle` + `ext-bundles/` | `bun pi-agent.js` (or `$DIR/bun` for Standalone — DIR-relative so it works from any cwd) |
| Snapshot / source / dev | `src/cli.ts` present | `bun pi-agent/src/cli.ts` (Snapshot) or `bun src/cli.ts` (dev) |

When the `.deploy-readonly` marker is present, `run.sh` exports `JITI_FS_CACHE=0` +
`PI_CODING_AGENT_DIR=$HOME/.pi/agent` (see `deploy-readonly.md`).

## Verify (the stable test)

`./run-test.sh high` (or `full`) — a `bun:test` suite
(`src/__tests__/e2e-extensions.test.ts`, gated on `PI_AGENT_E2E=1` +
`PI_AGENT_E2E_DEPLOY=1`) that deploys fresh packages, runs a probe extension
across SOURCE (repo + /tmp) and Bundle/Snapshot/Standalone (foreign cwd +
repo), and asserts:

- ZERO `conflict`/`cannot find`/`failed to load extension` in stderr.
- `matched > 0` — tool-bearing extensions loaded (probe counts `getAllTools()`
  by source-path marker).
- `cmdMatched > 0` — command-bearing extensions registered (covers extensions
  like pi-agent-ext-wayfind / -core-task that register slash commands but 0 tools).
- `skillMatched > 0` — a manifest-declared skill (`pi-agent-ext-superpowers`)
  loaded into `systemPromptOptions.skills` (probe on `before_agent_start`).

Kills on probe fire — no model call, fully offline. Catches cwd-coupled bugs
invisible to in-artifact testing or the model's `-p` self-report.

## Testing deployed artifacts — lessons

- **Run from a FOREIGN cwd**, not only from inside the artifact.
- **Test against a REAL installed repo** declaring the same extensions (surfaces
  cross-path conflicts), not a dummy package.
- **Verify via instrumentation** (probe extension → `getAllTools()` + `getCommands()`
  + source paths on `session_start`, skills on `before_agent_start`), not the
  model's reply in `-p` mode.
- **Rebuild before redeploying** — editing source does NOT update an
  already-deployed bundle.
