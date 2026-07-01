# Deploy packaging: self-contained pi-agent, any cwd

How `scripts/deploy.ts` + `run-dir/resolve.ts`'s DEPLOY-PACKAGE mode produce a
self-contained pi-agent that runs from **any** cwd, independent of the repo.

## The gap `deploy.ts` closes

`scripts/build.ts` bundles pi-agent to `dist/pi-agent/pi-agent.js`, but that
bundle resolves its extension set from the **repo's** `bun-apps/` (baked into
`src/generated/run-dir-base.ts` at build time). So the bundle only runs where
that repo path exists. `deploy.ts` copies the extension packages INTO the
output dir as `packages/<pkg>/…` alongside `run-dir/manifest.json`, and
`resolve.ts`'s deploy-package mode resolves the manifest against `packages/`
instead — so the result runs anywhere (same machine), no checkout required.

## The three resolve.ts modes

| Mode | when | resolves from | `-ne`? | layers with |
|---|---|---|---|---|
| **SOURCE** | `bun src/cli.ts` | repo `bun-apps/` | no | `<cwd>/.pi/` + `~/.pi/` (additive) |
| **REPO-BUNDLE** | `dist/pi-agent/pi-agent.js` (in repo) | build-time `run-dir-base.ts` | no | additive |
| **DEPLOY-PACKAGE** | bundle next to `packages/` + `run-dir/manifest.json` | `<pkg>/packages/` | **yes** | nothing — self-contained |

### Why DEPLOY-PACKAGE uses `-ne` (and the others don't)

`resource-loader.js` does `noExtensions ? cliPaths : merge(cliPaths, settingsPaths)`.

- Source/repo-bundle resolve extensions from `bun-apps/<pkg>/…` — the **same**
  canonical paths a repo `.pi/` would declare → pi dedupes them → additive
  layering with `.pi/` + `~/.pi/` is safe.
- Deploy-package resolves from `packages/<pkg>/…` — **different** paths than a
  repo declaring the same extensions. Without `-ne`, running the package inside
  such a repo loads both sets → `Tool "X" conflicts with …`. So deploy-package
  prepends `-ne`: pi loads ONLY the package's `-e` paths, ignoring `<cwd>/.pi/`.
  This is the bug that bit twice; `-ne` is the fix.

`-e` is `temporary` scope = trust-free + cwd-independent in all modes.

## What deploy.ts produces (flat — NO `.pi/`)

```
<outdir>/
├── pi-agent.js            # bundle (from dist/pi-agent/)
├── run-dir/manifest.json  # the extension/skill/npm set (resolve.ts reads this)
├── packages/<pkg>/…       # copied extension packages
├── package.json           # workspaces root + npm-ext deps
├── node_modules/          # wired by `bun install`
└── run.sh                 # layout-aware launcher (source + deployed)
```

Detection (no sentinel file): deploy-package = the bundle's own dir has both
`packages/` and `run-dir/manifest.json`.

## `run.sh` — one layout-aware launcher

Copied into every package. Picks its entry by what's present:

| detected | gate | entry |
|---|---|---|
| deployed package | `pi-agent.js` + `packages/` | `bun pi-agent.js` |
| source / dev | `src/cli.ts` | `bun src/cli.ts` |

`PIAGENT_DEBUG=1 ./run.sh …` prints the chosen mode/entry/cwd.

## Verify (the stable test)

`bun run verify` (or `./run-test.sh`) — a `bun:test` suite
(`src/__tests__/e2e-extensions.test.ts`, gated on `PI_AGENT_E2E=1`) that builds +
deploys a fresh package, runs a probe extension (`pi.getAllTools()`) across
SOURCE (repo + /tmp) and DEPLOY (foreign cwd + repo) scenarios, asserts ZERO
conflict/cannot-find/failed-to-load and `matched > 0`, and kills on probe fire
(no model call). Catches cwd-coupled bugs invisible to in-artifact testing or
the model's `-p` self-report. (Formerly `scripts/verify.ts`; folded into
`bun test` so the e2e shares the build/spawn harness and gate with
`e2e-patches.test.ts`.)

## Testing portable artifacts — lessons

- **Run from a FOREIGN cwd**, not only from inside the artifact.
- **Test against a REAL installed repo** declaring the same extensions (surfaces
  cross-path conflicts), not a dummy package.
- **Verify via instrumentation** (probe extension → `getAllTools()` + source
  paths on `session_start`), not the model's reply in `-p` mode.
- **Rebuild before redeploying** — editing source does NOT update an
  already-deployed bundle.
