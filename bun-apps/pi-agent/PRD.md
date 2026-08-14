# PRD — pi-agent

## Problem

Users want to run the full pi-agent TUI with additional LLM providers (lm-studio, ollama, openrouter) and a fixed set of project-specific extensions, without external config files or per-session extension loading. The official `pi` package has no mechanism for shipping hardcoded provider configs inside the source.

## Solution

A thin wrapper around the official `@earendil-works/pi-coding-agent` TUI. It calls `main()` untouched, then applies reversible monkey-patches to `ModelRegistry.prototype.loadModels()` so extra providers are registered before the first session starts. The repo's fixed extension set (pi-obsidian, pi-file2md, zai-mcp, etc.) is baked in via `run-dir/manifest.json`, independent of invocation `cwd`.

## Capabilities

| Feature | Detail |
|---------|--------|
| **TUI passthrough** | Full pi TUI, all flags, sessions, tools |
| **Extra providers** | lm-studio, ollama, openrouter, llamacpp — hardcoded in `src/pre-load-providers.ts` |
| **Fixed extension set** | `run-dir/manifest.json` — loads obsidian, vlm, flux2, krea2, ltx, movie-director, hermes, knowledge-card, research-tool, power-tool, web-access, workflow, zai-mcp |
| **Bundle support** | `bun scripts/deploy.ts` → single output `dist/pi-agent/pi-agent.js` |
| **Deploy (4 modes)** | `deploy.ts` — `--bundle` (default, THIN) · `--snapshot` (source-copy) · `--standalone` (bundle + bun binary) · `--exe` (single compiled binary, all assets embedded) |
| **E2E testing** | L2 (judgment) + L3 (real-model) + deploy e2e (bundle/snapshot/standalone × doctor + smoke + skill-load + readonly) |

## Key Dependencies

- `@earendil-works/pi-coding-agent` (official pi runtime)
- The `pi-agent-ext-*` workspace members — registered across two layers:
  static (`src/static-extensions.ts`, mirrored by `run-dir/manifest.json` →
  `staticExtensions`) + dynamic (`run-dir/manifest.json` → `extensions`).
  Counts are deliberately not restated: `run-dir/manifest-consistency.test.ts`
  asserts the two layers against the manifest, which is the source of truth.

> 📐 **Full extension dependency tree** (inter-package workspace DAG, per-package
> deps/peers, registration layer, observed debt) →
> [`docs/extension-dependency-tree.PRD.md`](docs/extension-dependency-tree.PRD.md).
> Consult it before any big change to the extension set.

## Deploy

Four self-contained deploy modes (see [`docs/deploy-cwd-trust.md`](docs/deploy-cwd-trust.md)
for the full layout reference):

```bash
bun scripts/deploy.ts                  # --bundle (default, THIN) → dist/pi-agent/
bun scripts/deploy.ts --snapshot       # source-copy  → dist/pi-agent/
bun scripts/deploy.ts --standalone     # bundle + bun binary → dist/pi-agent/
bun scripts/deploy.ts --exe            # single compiled binary → dist/pi-agent/pi-agent
```

`deploy.ts` no longer has a standalone `--verify` boot-probe step (dropped in
the bundle/snapshot/standalone/exe unification) — its job is now covered by
the e2e layers below, run per-mode instead of once at deploy time.

### Deploy verification layers

| Layer | What it checks | Where |
|-------|----------------|-------|
| **Runtime probe** (e2e) | `session_start` probe: tool load, command load, zero errors | `e2e-extensions.test.ts` |
| **doctor** (e2e) | Mode detection + static checks (ext-bundles, host-deps, providers) | `doctor --json` |
| **doctor --smoke** (e2e) | Runtime spawn: run-dir extensions actually loaded (matched > 0) | `doctor --smoke --json` |
| **skill-load** (e2e) | `before_agent_start`: superpowers SKILL.md in `systemPromptOptions.skills` | `e2e-extensions.test.ts` |
| **readonly** (e2e) | Frozen tree (chmod a-w): zero writes, foreign-cwd run, state routing | `e2e-readonly.test.ts` |

### Verification pipeline

```
         ┌───────────────┬───────────────┬───────────────┐
         ▼               ▼               ▼               ▼
      BUNDLE          SNAPSHOT       STANDALONE          EXE
  (THIN ext-bundles)  (raw source)  (bundle + bun)   (single binary)
         │               │               │               │
         ▼               ▼               ▼          CI-only smoke:
  ┌────────────────────────────────────────────┐    doctor + ext-doctor
  │ e2e-extensions.test.ts (per mode):          │    + binarySkills +
  │  · runtime probe  (session_start)           │    obsidian-exclusion
  │  · doctor --json  (mode + static checks)    │    (compile-verify CI job)
  │  · doctor --smoke (runtime spawn)           │
  │  · skill-load     (before_agent_start)      │
  ├──────────────────────────────────────────────┤
  │ e2e-readonly.test.ts (bundle + snapshot):    │
  │  · frozen tree (chmod a-w) zero writes       │
  │  · foreign-cwd run via run.sh                │
  │  · state routing to PI_CODING_AGENT_DIR      │
  └────────────────────────────────────────────┘
```

### Reproducibility

- **build-extensions hash cache**: sha256 over source tree + thin/full flag + `Bun.version`
  — the mechanism is intact (`scripts/lib/build-extensions.ts` + `ext-hash.ts`)
  but currently never hits via `deploy.ts`, since `main()` wipes the target dir
  (and its `.hash` sidecars) on every run before rebuilding.
- **read-only freeze**: every deploy is `chmod a-w` + `.deploy-readonly` marker by default; `run.sh` applies `JITI_FS_CACHE=0` + `PI_CODING_AGENT_DIR` routing

Run via:
```bash
bash bun-apps/pi-agent/run-test.sh high      # unit + patches + deploy e2e (bundle/snapshot/standalone)
bash bun-apps/pi-agent/run-test.sh readonly   # frozen-deploy contract (bundle + snapshot)
```

## Use

```bash
bun bun-apps/pi-agent/src/cli.ts   # source mode
# or
bun dist/pi-agent/pi-agent.js      # bundled mode
# or
bash dist/pi-agent/run.sh          # deployed mode (any cwd)
```

## Known behavior: `<REPO>/node_modules/` regenerates on launch (intentional)

Running `./pi-agent.sh` in source mode creates a gitignored `<REPO>/node_modules/`
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
