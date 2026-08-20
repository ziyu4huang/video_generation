# PRD — s2-agent

## Problem

Users want to run the full s2-agent TUI with additional LLM providers (lm-studio, ollama, openrouter) and a fixed set of project-specific extensions, without external config files or per-session extension loading. The official `pi` package has no mechanism for shipping hardcoded provider configs inside the source.

## Solution

A thin wrapper around the official `@earendil-works/pi-coding-agent` TUI. It calls `main()` untouched, then applies reversible monkey-patches — notably wrapping `ModelRuntime.create()` (pre-0.80 SDK this hooked `ModelRegistry.prototype.loadModels`; that method was removed when ModelRegistry became a stateless facade) — so extra providers are registered before the first session starts. The repo's fixed extension set is baked in via `run-dir/manifest.json`, independent of invocation `cwd`.

## Capabilities

| Feature | Detail |
|---------|--------|
| **TUI passthrough** | Full pi TUI, all flags, sessions, tools |
| **Extra providers** | lm-studio, ollama, openrouter, llamacpp — hardcoded in `src/pre-load-providers.ts` |
| **Fixed extension set** | `run-dir/manifest.json` — the single source of truth (static + dynamic layers; membership asserted by `run-dir/manifest-consistency.test.ts`, counts deliberately not restated here) |
| **Deploy** | `bun run deploy` → versioned minimal-core tree at `~/proj/dist/s2-agent-sh/<version>/` (drives `../s2-agent-ext-devops/scripts/deploy.ts`; see [`docs/deploy.md`](docs/deploy.md)) |
| **E2E testing** | L2 (judgment) + L3 (real-model) + deploy tree e2e (doctor + smoke + readonly, gated in CI) |

## Key Dependencies

- `@earendil-works/pi-coding-agent` (official pi runtime)
- The `s2-agent-ext-*` workspace members — registered across two layers:
  static (`src/static-extensions.ts`, mirrored by `run-dir/manifest.json` →
  `staticExtensions`) + dynamic (`run-dir/manifest.json` → `extensions`).
  Counts are deliberately not restated: `run-dir/manifest-consistency.test.ts`
  asserts the two layers against the manifest, which is the source of truth.

> 📐 **Full extension dependency tree** (inter-package workspace DAG, per-package
> deps/peers, registration layer, observed debt) →
> [`docs/extension-dependency-tree.PRD.md`](docs/extension-dependency-tree.PRD.md).
> Consult it before any big change to the extension set.

## Deploy

One deploy: a versioned, frozen tree of a minimal compiled core plus one
`ext/<name>/` dir per extension, discovered at runtime. See
[`docs/deploy.md`](docs/deploy.md) for the full reference.

```bash
bun run --cwd bun-apps/s2-agent deploy          # cut a new version, move `current`, prune old ones
```

(Run from the package dir; `deploy` shells into `../s2-agent-ext-devops/src/deploy-cli.ts`, which drives `scripts/deploy.ts` — the single deploy pipeline since the consolidation. See `docs/deploy.md`.)

Verification is not restated here: the deploy's six gates, its e2e tiers, and
the read-only freeze contract live in ONE place — [`docs/deploy.md`](docs/deploy.md)
("The six gates", "E2E tiers", "The tree is read-only"). This PRD previously
duplicated them with the retired bundle/snapshot/standalone/exe pipeline diagram
and a `run-test.sh high`/`readonly` invocation path that no longer exists.

## Use

```bash
bun bun-apps/s2-agent/src/cli.ts   # source mode
# or
bash ~/proj/dist/s2-agent-sh/current/run.sh   # deployed mode (any cwd)
```

## Known behavior: `<REPO>/node_modules/` regenerates on launch (intentional)

Running `./s2-agent.sh` in source mode creates a gitignored `<REPO>/node_modules/`
(symlinks into Bun's global store: `@earendil-works/*` + `@repo/*` workspace links +
`typebox`). `git clean -dxf` wipes it; the next launch recreates it. This is
**deliberate** — created by the `ensure-extension-deps` patch
(`src/patches/ensure-extension-deps.ts`) — and is **required** for extensions to load.
Do not remove it.

**Why it exists:** pi loads each `-e` extension via `jiti`, which first tries `try-native`
(Bun imports the .ts directly). That try fails when the extension's bare specifiers
(`@earendil-works/*`, `typebox`, `@repo/*` peerDeps) are not on the node_modules walk-up
path from the extension's own file — Bun's isolated linker does not reliably symlink every
workspace peerDep into each consumer. On failure, jiti falls back to transforming the whole
graph, and under Bun + jiti 2.7.0 any transformed module over ~4 KB trips a broken
temp-file path (`NameTooLong` / `Cannot find .../jiti-esm/binary-*.mjs`), leaving large
extensions un-loadable (flux2/binary.ts, hermes 40 KB+, obsidian-lib 138 KB). Symlinking
those packages at repo-root node_modules — which is on the walk-up path from every
`bun-apps/*` member — makes `try-native` succeed, so Bun imports natively (no size limit)
and jiti never transforms. Confirmed: `BUN_PI_ENSURE_EXT_DEPS=0` suppresses the root
node_modules entirely (and re-exposes the extension load failures).

**Scope & cost:** source mode only (bundle mode symlinks its own node_modules at build;
binary mode ships static factories). Idempotent and cheap — relinks only when a target
moved (e.g. after a `bun install` re-pinned a version). Gitignored, so harmless to git; a
pure symlink folder, so near-free to recreate. If the folder is unwanted cosmetically,
`git clean -dxf` removes it — it returns on the next launch by design.

## Cross-reference

- [`PRD-e2e-testing.md`](./PRD-e2e-testing.md) — the e2e judgment test layer spec
- [`docs/pi-cross-machine-setup.md`](docs/pi-cross-machine-setup.md) — fresh-machine setup
- [`docs/extension-dependency-tree.PRD.md`](docs/extension-dependency-tree.PRD.md) — the extension dependency graph (what depends on what; baseline for big changes)
- [`docs/extension-registry.PRD.md`](docs/extension-registry.PRD.md) — how extensions physically load (manifest, peerDeps, jiti/Bun resolution)
- [`docs/slash-commands-tools-skills.md`](docs/slash-commands-tools-skills.md) — how slash commands, tools, skills, and extensions relate at runtime
