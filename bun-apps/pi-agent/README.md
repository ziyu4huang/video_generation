# pi-agent

A **thin wrapper** around the **real pi TUI** with **monkey-patch hooks**.

It does *not* reimplement pi. It calls the official `main()` from
`@earendil-works/pi-coding-agent` untouched, then layers reversible
monkey-patches to extend default behavior.

## Purpose

You want the full pi experience (TUI, all flags, sessions, tools) but with
additional providers added — local servers (lm-studio, ollama, llamacpp) or
remote APIs (openrouter) — hardcoded in source without any external config file.

All providers are defined in **`src/pre-load-providers.ts`**. No `~/.pi/agent/models.json` is read.

## How it works

```
pi-agent/src/cli.ts
  1. applyPatches()              ← monkey-patches ModelRegistry.prototype
  2. await main(process.argv)    ← the REAL pi TUI / print / rpc
```

### Why patch `loadModels()`, not `registerProvider()`

`ModelRegistry` constructor calls the private `loadModels()` directly,
not `refresh()`. The patch wraps `loadModels()` so that after the built-in
catalog loads, it immediately calls the real `registerProvider("lm-studio", ...)`
with config hardcoded here. `registerProvider` also stores the config in
`registeredProviders`, so any later `refresh()` replays it automatically.

Because Bun's module cache is shared process-wide, `cli.ts` and `main()`
import the **same** `ModelRegistry` class object. Patching its prototype
before `main()` runs affects every registry instance `main()` constructs.
No source fork, no passthrough rewrite.

## Setup

```bash
bun install          # at the monorepo root (never inside pi-agent/)
```

## Usage

The portable launcher (works from any cwd — resolves its own location):

```bash
./bun-apps/pi-agent/run.sh                 # interactive TUI
./bun-apps/pi-agent/run.sh -p "hello"      # print mode
./bun-apps/pi-agent/run.sh --list-models   # list models
```

(Equivalent to `bun bun-apps/pi-agent/src/cli.ts …` but cwd-independent.)

Alias in `~/.zshrc`:

```sh
alias pi='/abs/path/to/bun-apps/pi-agent/run.sh'
alias pi-stock='bunx @earendil-works/pi-coding-agent'
```

## Patches

| Env | Default | Effect |
|-----|---------|--------|
| `BUN_PI_PRE_LOAD_PROVIDERS` | `1` (on) | Inject all providers defined in `src/pre-load-providers.ts` |
| `BUN_PI_SET_PACKAGE_DIR` | `1` (on) | Pin `PI_PACKAGE_DIR` for asset/theme resolution in bundle mode |
| `BUN_PI_SKIP_UPDATE_CHECK` | `1` (on) | Silence pi's "Update Available" banner for bundle/binary (source mode keeps it) |
| `BUN_PI_DEBUG_PATCHES` | `0` (off) | Print which patches were applied on startup |

Toggle:

```bash
BUN_PI_PRE_LOAD_PROVIDERS=0 bun bun-apps/pi-agent/src/cli.ts --list-models   # custom providers hidden
BUN_PI_DEBUG_PATCHES=1      bun bun-apps/pi-agent/src/cli.ts                  # show patch status
```

## Add or change providers

Edit **`src/pre-load-providers.ts`** → `PROVIDERS` object. No other file needs to change.

```typescript
// Uncomment or add a new entry:
"openrouter": {
  baseUrl: "https://openrouter.ai/api/v1",
  api: "openai-completions",
  apiKey: { env: "OPENROUTER_API_KEY" },   // read from env, not hardcoded
  models: [
    { id: "mistralai/mistral-nemo:free", name: "Mistral Nemo (OR free)",
      reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 4_096 },
  ],
},
```

Changes take effect on the next `bun` invocation — no build step.

## Deploy — package pi-agent + extensions

`scripts/build.ts` only bundles pi-agent itself. **`scripts/deploy.ts`**
produces a self-contained, runnable directory that bundles pi-agent **plus a
whitelisted set of extension packages**, ready to `cd` into and run anywhere
on the same machine.

```bash
bun scripts/deploy.ts                              # default out: dist/pi-agent-deploy
bun scripts/deploy.ts --only pi-obsidian,pi-vlm    # whitelist via CLI
bun scripts/deploy.ts /tmp/my-pkg                  # custom out-dir
bun scripts/deploy.ts --no-build                   # reuse existing bundle
bun scripts/deploy.ts --symlink-pkgs               # symlink instead of copy
bun scripts/deploy.ts -h                           # full help
```

**Whitelist resolution** (first wins): `--only <names>` → `deploy.config.json`
`extensions` → all local packages in `.pi/settings.json`. Transitive local
workspace peers are auto-included (e.g. pi-knowledge-card pulls in pi-obsidian)
so bare-specifier imports resolve. `npm:` registry packages are always
carried over unless `--no-npm`.

The deployed dir:

```
<outdir>/
├── pi-agent.js          # bundle
├── packages/<name>/…    # whitelisted (+ auto-peer) extension packages
├── .pi/settings.json    # generated manifest
├── package.json         # workspace root (workspaces: ["packages/*"])
├── node_modules/        # wired by `bun install`
└── README.md
```

Run it:

```bash
cd <outdir>
bun pi-agent.js --list-models   # smoke test
bun pi-agent.js                 # interactive TUI
```

**Portability:** `pi-agent.js` embeds an absolute `PI_PACKAGE_DIR` (see
`scripts/build.ts` stage 0) for theme/asset resolution, so the package is
portable across paths on the **same machine**. For a different machine,
rebuild (`scripts/build.ts`) there first.

**Run from anywhere.** The deployed binary self-locates: `bun <pkg>/pi-agent.js`
works from any cwd (it re-injects the baked extensions as `-e` flags and skips
the cwd preflight). See `docs/deploy-cwd-trust.md` for why this is needed
(pi's resource discovery is cwd- and trust-coupled) and how it was verified.

## Build modes

Two execution modes are supported and **both load extensions correctly**:

| Mode | Command | How extensions resolve deps |
|------|---------|------------------------------|
| **Source** (no build) | `bun src/cli.ts` | pi resolves via the real node_modules tree |
| **Bundle** | `bun ../../dist/pi-agent/pi-agent.js` | build symlinks `dist/pi-agent/node_modules` → pi's bun-store so `getAliases()` can `require.resolve("typebox")` |

```bash
bun scripts/build.ts          # bundle → dist/pi-agent/pi-agent.js (+ node_modules symlink)
bun scripts/build.ts --all    # bundle + standalone binary
```

The `--compile` binary (`dist/pi-agent/pi-agent`) **cannot load `.ts` extensions**:
in `isBunBinary` mode jiti feeds each extension as a `data:text/javascript;base64,…`
URL, and Bun's compiled resolver rejects it with `NameTooLong` (`ENAMETOOLONG`).
This is a bun-compile + jiti limitation, not a pi-agent bug — run the binary with
`-ne` (no extensions) or use source/bundle mode when extensions are needed.

## Add your own patch

1. Create `src/patches/<name>.ts` that patches a prototype/module.
2. Register it (env-gated) in `src/patches/index.ts`.

`cli.ts` never needs to change.

## Layout

```
pi-agent/
├── package.json            # bin: pi-agent → src/cli.ts
├── README.md
├── run.sh                  # portable launcher (cwd-independent) → src/cli.ts
├── deploy.config.json      # whitelist for `scripts/deploy.ts`
└── src/
    ├── cli.ts                    # applyPatches() → main(argv)
    ├── pre-load-providers.ts     # PROVIDERS config + patch logic (edit this)
    └── patches/
        └── index.ts              # registry (env-gated) + debug
```

## Known issues

- **Standalone binary cannot load `.ts` extensions** (`./dist/pi-agent/pi-agent`).
  In `isBunBinary` mode, jiti feeds each extension as a
  `data:text/javascript;base64,…` URL; Bun's compiled resolver treats it as a
  path and fails with `NameTooLong` (`ENAMETOOLONG`). This is a bun-compile +
  jiti limitation, not a pi-agent regression. Workaround: run the binary with
  `-ne` (no extensions), or use **source** / **bundle** mode when extensions
  are needed. Provider injection (`pre-load-providers`) still works in the
  binary — only `.ts` extension loading is affected.

## Related

- **[pi-agent-cli](../pi-agent-cli/README.md)** — single-turn scripted workflows
  (`vlm-describe`, `zk-extract`, `zk-ask`, `pipeline pdf-to-vault`) with extensions
  baked in as workspace deps. Use this when you want one-shot automation or to call
  a specific agent workflow from a script — not an interactive session.
