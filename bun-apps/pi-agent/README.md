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

This repo's fixed extension/skill set (pi-obsidian, pi-vlm, zai-mcp, etc.) is baked in via
**`run-dir/`**, independent of invocation `cwd` — see [Extensions via run-dir](#extensions-via-run-dir)
below. Session/auth/model data always stays at `~/.pi/agent/` (pi's own default, untouched).

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

```bash
# interactive TUI (the real thing)
bun bun-apps/pi-agent/src/cli.ts

# print mode
bun bun-apps/pi-agent/src/cli.ts -p "hello"

# list models — lm-studio entries appear alongside built-ins
bun bun-apps/pi-agent/src/cli.ts --list-models

# load an EXTRA extension on top of the run-dir set (see below) without pi install
bun bun-apps/pi-agent/src/cli.ts -e bun-apps/zai-mcp/extensions/zai-mcp.ts -p "list your tools"
```

### Optional: alias in `~/.zshrc`

```sh
alias pi='bun /path/to/repo/bun-apps/pi-agent/src/cli.ts'
alias pi-stock='bunx @earendil-works/pi-coding-agent'
```

## Patches

| Env | Default | Effect |
|-----|---------|--------|
| `BUN_PI_PRE_LOAD_PROVIDERS` | `1` (on) | Inject all providers defined in `src/pre-load-providers.ts` |
| `BUN_PI_SET_PACKAGE_DIR` | `1` (on) | Pin `PI_PACKAGE_DIR` for asset/theme resolution in bundle mode |
| `BUN_PI_SKIP_UPDATE_CHECK` | `1` (on) | Silence pi's "Update Available" banner for bundle/binary (source mode keeps it) |
| `BUN_PI_LOAD_RUN_DIR` | `1` (on) | Splice `run-dir/`'s extensions/skills into argv as absolute `-e`/`--skill` paths |
| `BUN_PI_DEBUG_PATCHES` | `0` (off) | Print which patches were applied on startup |
| `BUN_PI_DEBUG_RUN_DIR` | `0` (off) | Print the resolved `run-dir/` argv fragment on startup |

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

## Extensions via run-dir

pi's vendored `main()` has no `--cwd` flag — it threads a single `process.cwd()` into
every project-resource lookup (`.pi/settings.json`, `.pi/extensions`, etc.), so a
project's extension list normally only loads when invoked with `cwd === that project's
root`. That made this repo's old `.pi/settings.json` `"packages"` list a `<PWD>/.pi/`
hack: copy/deploy pi-agent elsewhere, or invoke it via the `~/.zshrc` alias from any
other directory, and every extension silently vanished.

Fix: `-e`/`--extension` and `--skill` accept **absolute paths**, which bypass `cwd`
resolution and trust-gating entirely. `run-dir/manifest.json` declares this repo's
fixed extension/skill set (paths relative to `bun-apps/`); `run-dir/resolve.ts`
resolves them to absolute paths (`import.meta.dir`-based in source mode, via a
build-time-generated constant in bundle mode — same pattern as `PI_PKG_DIR` below);
and the `load-run-dir-resources` patch splices them into argv before `main()` runs.
The result: pi-agent loads the exact same extensions regardless of invocation `cwd`,
and never reads or writes anything under `<cwd>/.pi/`.

The 3 extensions previously installed into the old, isolated `.pi/npm/node_modules/`
tree (`@juicesharp/rpiv-ask-user-question`, `pi-hermes-memory` — `rpiv-todo` is
deliberately excluded, see the comment in `run-dir/resolve.ts`) are now plain
`dependencies` in this package's own `package.json`, sharing the monorepo's single
`node_modules` tree like everything else.

To add/remove a workspace-local extension or skill, edit `run-dir/manifest.json`
(paths relative to `bun-apps/`). To add/remove an npm-sourced one, add it as a
`dependency` in `package.json` AND add its `{ pkg, entry }` to the
`npmExtensions` array in `run-dir/manifest.json` — that one array is the single
source of truth read by both `run-dir/resolve.ts` (source mode) and
`scripts/build.ts` (which bakes resolved paths into the bundle).

> `rpiv-todo` is intentionally NOT in `npmExtensions`: this user's global
> `~/.pi/agent/settings.json` already loads it, so a second copy here crashes
> with `Tool "todo" conflicts`. Another clone/environment must add it to their
> OWN `~/.pi/agent/settings.json` to get the `todo` tool.

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

Building also generates `src/generated/run-dir-base.ts` (gitignored) — `BUN_APPS_DIR`
and pre-resolved npm-extension paths, baked in because `import.meta.dir` reflects the
*bundle's* location once built, not the original source file's. **Portability
caveat**: this makes the bundle work from any invocation directory *on the machine it
was built on* (same trade-off the existing `PI_PKG_DIR`/node_modules-symlink pattern
already accepts) — not relocatable to a different host/filesystem layout unless
`bun-apps/` is copied to the identical absolute path there too.

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
├── package.json            # bin: pi-agent → src/cli.ts; also holds the migrated npm extension deps
├── README.md
├── run-dir/
│   ├── manifest.json          # this repo's fixed extension/skill list (edit this)
│   └── resolve.ts             # resolves manifest.json to absolute -e/--skill argv
└── src/
    ├── cli.ts                    # applyPatches() → main(argv)
    ├── pre-load-providers.ts     # PROVIDERS config + patch logic (edit this)
    ├── generated/                # build-time-baked constants (gitignored)
    └── patches/
        ├── index.ts                    # registry (env-gated) + debug
        └── load-run-dir-resources.ts   # splices run-dir/ into argv
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
