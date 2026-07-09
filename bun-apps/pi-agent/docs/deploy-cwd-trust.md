# Deploy packaging: self-contained pi-agent, any cwd

How `scripts/deploy.ts` + `run-dir/resolve.ts` produce a self-contained pi-agent
that runs from **any** cwd, independent of the repo (same machine).

## The gap `deploy.ts` closes

`scripts/build.ts` bundles pi-agent to `dist/pi-agent/pi-agent.js`, but that bundle
resolves its extension set from the **repo's** `bun-apps/` (baked into
`src/generated/run-dir-base.ts` at build time). So the bundle only runs where
that repo path exists. `deploy.ts` copies/bundles the extension packages INTO
the output dir alongside `run-dir/manifest.json`, and `resolve.ts`'s deploy
modes resolve from there — so the result runs anywhere (same machine), no
checkout required.

## The four deploy modes (`deploy.ts <flags>`)

| Mode | flag | what ships | resolve.ts layout | `bun install`? |
|---|---|---|---|---|
| **DEPLOY-BUNDLE** (default) | *(none)* | pre-bundled `ext-bundles/*.thin.js` + symlinked node_modules | `.deploy-bundle` + `ext-bundles/` | no (symlink) |
| **DEPLOY-PORTABLE** | `--portable` | FULL-bundled `ext-bundles/*.full.js` + host node_modules subset | `.deploy-bundle` + `.deploy-portable` | yes (`--production`) |
| **DEPLOY-PACKAGE** | `--release` | copied `packages/<pkg>/` source | `packages/` + `run-dir/manifest.json` | yes (`--production`) |
| *(SOURCE / REPO-BUNDLE)* | — | *(not a deploy — `bun src/cli.ts` or the in-repo `dist/pi-agent`)* | none of the markers | — |

### resolve.ts layout detection (marker-based)

`detectRunDirMode(selfDir)` checks, in precedence order:

1. `.deploy-bundle` marker **+** `ext-bundles/` dir → **deploy-bundle** (default + `--portable`)
2. `packages/` dir **+** `run-dir/manifest.json` → **deploy-package** (`--release`)
3. otherwise → **source** (repo source / a plain in-repo bundle)

The `.deploy-portable` marker (set by `--portable`) is a sub-flag of
deploy-bundle: it tells resolve.ts to skip npm-extension abs paths (they're
FULL-bundled, so emitting a separate `-e` would re-introduce a repo dependency).

### Why deploy modes use `-ne` (and source doesn't)

`resource-loader.js` does `noExtensions ? cliPaths : merge(cliPaths, settingsPaths)`.

- Source/repo-bundle resolve extensions from `bun-apps/<pkg>/…` — the **same**
  canonical paths a repo `.pi/` would declare → pi dedupes them → additive
  layering with `.pi/` + `~/.pi/` is safe.
- Deploy modes resolve from `packages/<pkg>/…` or `ext-bundles/*.js` —
  **different** paths than a repo declaring the same extensions. Without `-ne`,
  running the deploy inside such a repo loads both sets → `Tool "X" conflicts`.
  So deploy modes prepend `-ne`: pi loads ONLY the deploy's `-e` paths, ignoring
  `<cwd>/.pi/`. This is the bug that bit twice; `-ne` is the fix.

`-e` is `temporary` scope = trust-free + cwd-independent in all modes.

## What deploy.ts produces

### DEPLOY-BUNDLE (default)

```
<outdir>/
├── pi-agent.js            # bundle (from dist/pi-agent/)
├── ext-bundles/*.thin.js  # pre-bundled extensions (THIN — shared deps external)
├── skills/<dir>/          # copied skill dirs (manifest.skills)
├── run-dir/manifest.json  # compat/debug (resolve.ts uses dir listings, not this)
├── node_modules           # symlink → pi deps store (pi-agent.js peer-dep resolution)
├── .deploy-bundle         # marker — resolve.ts DEPLOY-BUNDLE detection
├── package.json           # minimal {name,private,type} — NO workspaces
└── run.sh                 # layout-aware launcher
```

### DEPLOY-PACKAGE (`--release`)

```
<outdir>/
├── pi-agent.js, run-dir/manifest.json, run.sh
├── packages/<pkg>/…       # copied extension source (readable)
├── package.json           # workspaces root + npm-ext deps
└── node_modules/          # wired by `bun install --production`
```

### DEPLOY-PORTABLE (`--portable`)

Same layout as DEPLOY-BUNDLE but `ext-bundles/*.full.js` (FULL-bundled, zero
bare specifiers) + a real `node_modules/` subset (installed, not symlinked) +
`.deploy-portable` marker. Repo-independent on the same machine (bun's global
store isn't cross-machine relocatable).

## `run.sh` — one layout-aware launcher

Copied into every package. Picks its entry by what's present:

| detected | gate | entry |
|---|---|---|
| deployed (bundle/release/portable) | `pi-agent.js` + (`ext-bundles/` or `packages/`) | `bun pi-agent.js` |
| source / dev | `src/cli.ts` | `bun src/cli.ts` |

`PIAGENT_DEBUG=1 ./run.sh …` prints the chosen mode/entry/cwd. When the
`.deploy-readonly` marker is present, `run.sh` exports `JITI_FS_CACHE=0` +
`PI_CODING_AGENT_DIR=$HOME/.pi/agent` (see `deploy-readonly.md`).

## Verify (the stable test)

`./run-test.sh high` (or `full`) — a `bun:test` suite
(`src/__tests__/e2e-extensions.test.ts`, gated on `PI_AGENT_E2E=1`) that builds +
deploys a fresh package, runs a probe extension across SOURCE (repo + /tmp) and
all 3 DEPLOY modes (foreign cwd + repo), and asserts:

- ZERO `conflict`/`cannot find`/`failed to load extension` in stderr.
- `matched > 0` — tool-bearing extensions loaded (probe counts `getAllTools()`
  by source-path marker).
- `cmdMatched > 0` — command-bearing extensions registered (covers extensions
  like pi-planning-with-files that register slash commands but 0 tools).
- `skillMatched > 0` — a manifest-declared skill (`pi-planning-with-files`)
  loaded into `systemPromptOptions.skills` (probe on `before_agent_start`).

Kills on probe fire — no model call, fully offline. Catches cwd-coupled bugs
invisible to in-artifact testing or the model's `-p` self-report.

## Testing portable artifacts — lessons

- **Run from a FOREIGN cwd**, not only from inside the artifact.
- **Test against a REAL installed repo** declaring the same extensions (surfaces
  cross-path conflicts), not a dummy package.
- **Verify via instrumentation** (probe extension → `getAllTools()` + `getCommands()`
  + source paths on `session_start`, skills on `before_agent_start`), not the
  model's reply in `-p` mode.
- **Rebuild before redeploying** — editing source does NOT update an
  already-deployed bundle.
