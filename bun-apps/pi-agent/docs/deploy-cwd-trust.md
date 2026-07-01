# Deployed package: cwd & trust behavior (and the bug it fixed)

How `scripts/deploy.ts` + `src/deploy-mode.ts` make `bun <pkg>/pi-agent.js`
work from **any** cwd. Read alongside `pi-internals.md`.

## The bug (reported)

Running the deployed binary from a foreign cwd failed:

```
bun /tmp/test-pi-agent-package-…/pi-agent.js
✗ pi-agent preflight: workspace deps unresolved.
  pi's extensions will fail to load. Missing:
    pi-knowledge-card → pi-obsidian
```

## Root causes (two, both cwd-coupling)

pi couples resource discovery to `process.cwd()` AND to project trust. Both
are documented in `pi-internals.md` §5 and the project memory, but in short:

1. **Resource discovery is cwd-based.** `ResourceLoader` resolves everything
   via `join(this.cwd, ".pi", …)` (`dist/core/resource-loader.js:574-577`,
   `:752,:763`). `package-manager.js` resolves `.pi/settings.json` `packages`
   entries relative to `join(cwd, CONFIG_DIR_NAME)` = `<cwd>/.pi`
   (`:687`, `projectBaseDir`). So from a foreign cwd, pi reads *that* cwd's
   `.pi/` and the package's baked extensions never load — and the pi-agent
   `preflight` (`src/preflight.ts`) walks up from cwd, latching onto an
   *unrelated, uninstalled* pi monorepo and failing.

2. **Settings-declared packages are `project` scope** → pi loads them only
   after **project trust** is granted. Non-interactive (print) runs and
   freshly deployed dirs are untrusted, so project-scope extensions are
   skipped silently. (The trust store `~/.pi/agent/trust.json` is **flat**
   `{"/abs/path": true|false|null}`; a stray object value throws
   `Invalid trust store …`.)

## The fix — self-locating launcher (`src/deploy-mode.ts`)

`detectDeployMode()` runs at the top of `cli.ts`. When the bundled
`pi-agent.js` sits in a deploy layout — detected by a sentinel
`.pi-deploy-marker.json` (written by `deploy.ts`) **plus** `.pi/settings.json`
**plus** `packages/` — it **always**:

1. Reads the package's own `.pi/settings.json` and, for each local
   `../packages/<name>` entry, resolves the extension `.ts` files via the
   package's `pi.extensions` field (default `["./extensions"]`).
2. Prepends `-ne` plus those paths as `-e <abs-path>` flags to argv.
3. Skips the cwd-based preflight.

`-e` is `temporary` scope — **trust-free and cwd-independent** — so baked
extensions load everywhere. The **`-ne` is essential**: it makes pi load ONLY
the `-e` paths and skip settings-declared extensions
(`resource-loader.js:270` — `noExtensions ? cliEnabledExtensions : merge(...)`).
Without `-ne`, running inside a repo that declares the *same* extensions
causes both sets to load → `Tool "X" conflicts with …`. With `-ne`, only the
package's baked extensions register, exclusively, in every cwd.

### Why `-e` and not `chdir`?

`chdir(pkgDir)` would also fix loading but would make pi *operate* on the
package dir, not the user's project — wrong for a portable launcher. `-e`
injection keeps `cwd` = the user's real project while baking the extensions in.

### What `deploy.ts` writes

- `pi-agent.js` (+ optional `.map`)
- `packages/<name>/…` — copied extension packages
- `package.json` — workspace root (`workspaces: ["packages/*"]` + aggregated deps) for `bun install`
- `.pi/settings.json` — entries `../packages/<name>` (relative to `.pi`); **npm: entries dropped if not installed** (post-install filter) so they can't break startup
- `.pi-deploy-marker.json` — the sentinel consumed by `deploy-mode.ts`
- `node_modules/` — wired by `bun install`
- `README.md`
- `run.sh` — a copy of `bun-apps/pi-agent/run.sh`; the same launcher works
  in the deployed dir because it auto-detects the bundle layout (see below)

## deploy.ts is decoupled from the repo's `.pi/`

A self-contained package must be buildable from the **workspace alone**, not
from the repo's `.pi/settings.json`. Confirmed by deleting the entire repo
`.pi/` and redeploying successfully: `deploy.ts` resolves the workspace root
by walking up from its own location for a `package.json` with `workspaces`
next to a `bun-apps/` directory (`findWorkspaceRoot()`), falling back to
`findPiRepoRoot()` only if needed. The whitelist sources, in priority order:

1. `--only a,b,c` (CLI)
2. `deploy.config.json` `{ "extensions": [...] }`
3. **all `bun-apps/*` packages that have an `extensions/` dir** (default)

`.pi/settings.json` is consulted only as an *extra* package source and for
`npm:` registry carryover — both gracefully no-op when it's absent. So the
deployed package is fully independent of the repo's project config: removing
`.pi/` (settings, workflows, benchmarks, vault config) does not affect
packing or the resulting bundle.

The **source** pi-agent, by contrast, DOES read the repo's `.pi/settings.json`
for its project extension set. With `.pi/` gone it still runs fine — just
without the project's extensions (builtins + user-global only). That is the
key asymmetry: the package bakes its extensions in; source mode discovers
them at runtime from `.pi/`.

## `run.sh` — one layout-aware launcher

`bun-apps/pi-agent/run.sh` is copied into every deploy dir. It picks its
entry by what's present, so the same script works in both contexts:

| detected layout | gate | entry | node_modules context |
|---|---|---|---|
| deployed package | `pi-agent.js` + `.pi-deploy-marker.json` | `bun pi-agent.js` | the package's own |
| source / dev | `src/cli.ts` | `bun src/cli.ts` | the repo workspace |

`PIAGENT_DEBUG=1 ./run.sh …` prints the chosen mode/entry/cwd to stderr.

## Verified behavior matrix

| Invocation | baked extensions load? | preflight | conflicts | how |
|---|---|---|---|---|
| `bun <pkg>/pi-agent.js` from foreign cwd (no `.pi`) | ✅ 22 | skipped | none | `-ne` + `-e` inject |
| from an *uninstalled* pi monorepo cwd | ✅ 22 | skipped (was bug #1) | none | `-ne` + `-e` inject |
| from an *installed* repo with the SAME extensions | ✅ 22 | skipped | none (was bug #2) | `-ne` suppresses cwd's; `-e` loads pkg's |
| `cd <pkg> && bun pi-agent.js` | ✅ 22 | skipped | none | `-ne` + `-e` inject |

Numbers from a 4-extension whitelist (pi-obsidian, pi-vlm, pi-knowledge-card,
zai-mcp) → 22 tools, verified via a probe extension dumping
`pi.getAllTools()` to stderr on `session_start`.

## Testing portable artifacts — the lesson

- **Always invoke from a foreign cwd**, not only from inside the artifact.
  cwd-coupled bugs are invisible when cwd == artifact dir.
- **Test against a REAL installed repo that declares the same extensions**,
  not a fake/dummy monorepo. A dummy package that isn't a real extension
  won't surface tool-name conflicts — the second failure mode.
- **Verify via instrumentation**, not the model's self-report in `-p` mode
  (it routinely omits extension tools). A one-file probe extension that
  prints `pi.getAllTools()` names + `sourceInfo.path` on `session_start` is
  ground truth.
- **Rebuild before redeploying.** Editing source does NOT update an already-
  deployed `pi-agent.js` bundle — the baked bundle is stale until
  `scripts/build.ts` re-runs. A user testing the old package sees old behavior.
- Don't hand-edit `~/.pi/agent/trust.json` with object values — it must stay
  flat `{path: bool|null}` or pi throws on every project run.
