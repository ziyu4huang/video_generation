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
| `BUN_PI_DEFAULT_MODEL_ENV` | `1` (on) | Bridge `PI_MODEL` / `PI_PROVIDER` / `PI_THINKING` env into argv as `--model` / `--provider` / `--thinking` when not already passed — the real pi TUI ignores these env vars (only pi-agent-cli reads them); this makes a shell `PI_MODEL=…` default apply to the interactive TUI too |
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

### Lazy / opt-in extensions (`-e <alias>`)

Everything in `manifest.json` above loads **every** session — fine for cheap,
general-purpose extensions, wrong for heavy on-demand ones (e.g.
`pi-dynamic-workflows`'s `workflow` tool costs ~2.5k tok/req). Those live in a
separate **lazy registry**, `run-dir/settings.json`:

```json
{ "lazyExtensions": { "workflow": "pi-dynamic-workflows/extensions/workflow.ts", … } }
```

A lazy entry costs **zero** context unless you ask for it by alias:

```bash
# default session: dynamic-workflows NOT loaded (no token cost)
bun bun-apps/pi-agent/src/cli.ts -p "…"

# opt in for one invocation — the alias resolves to the real factory file
bun bun-apps/pi-agent/src/cli.ts -e workflow -p "audit src/ for missing auth"
bun bun-apps/pi-agent/src/cli.ts -e dynamic-workflows -p "…"
bun bun-apps/pi-agent/src/cli.ts -e flux2 -p "…"
```

`run-dir/resolve.ts` rewrites `-e <alias>` to the absolute path before `main()`
sees argv. Resolution (first hit wins): exact alias key (case-insensitive) →
unique substring match (ambiguous → no guess, defers to SDK) → directory
fallback (`<bun-apps>/<alias>/extensions/` with exactly one `.ts`). Real paths
and URL schemes (`npm:`, `git:`, `file:`, `./…`, `/abs/…`) are passed through
untouched, so `-e /real/path.ts` still works. To register a new opt-in
extension, add one line to `run-dir/settings.json`.

## Cross-machine portability

The run-dir mechanism makes extension loading cwd-independent, but a fresh machine still
needs its env-var contract in place (`MLX_MODELS_DIR`, `MLX_OUTPUT_DIR`, `OB_VAULT_PATH`,
…). The canonical reference + setup steps live in
[`docs/pi-cross-machine-setup.md`](../../docs/pi-cross-machine-setup.md), and
`pi-agent-cli` ships a `doctor` self-check that verifies everything is wired:

```bash
bun bun-apps/pi-agent-cli/src/cli.ts doctor [--json] [--fix]
```

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

## Deploy

`scripts/deploy.ts` packages pi-agent + its extension set into a self-contained
dir runnable from any cwd. Two modes:

```bash
bun scripts/deploy.ts [out-dir]              # DEFAULT (bundle): pre-bundled ext + skills
bun scripts/deploy.ts [out-dir] --release    # RELEASE (source-copy): packages/ + bun install
```

| Mode | Layout | Extensions | node_modules |
|---|---|---|---|
| **bundle** (default) | `ext-bundles/*.thin.js` + `skills/` + `.deploy-bundle` | each ext pre-bundled to one `.js` (`scripts/build-extensions.ts`, THIN — shared typebox) | not copied (redundant); opt in `--with-nm-copy` |
| **--release** | `packages/<pkg>/…` (source) + workspaces `package.json` | source folders copied verbatim | wired by `bun install` |

`run-dir/resolve.ts` auto-detects the layout at runtime (`.deploy-bundle` +
`ext-bundles/` → bundle; `packages/` + manifest → release) and injects `-ne` +
the resolved `-e`/`--skill` paths, so the package is self-contained.

**Same-machine caveat (bundle mode):** THIN bundles + pi-agent.js + npm exts all
resolve deps via baked absolute paths into the repo's `.bun` store, so a bundle
deploy runs anywhere *on the machine it was built on* (matching the bundle
portability caveat above) — not relocatable to another host. For a truly
portable artifact, copy the repo to the same absolute path on the target first,
or rebuild there. `--release` + `bun install` is the relocatable alternative.

```bash
bun scripts/deploy.ts /tmp/pi-bundle         # build + deploy (bundle)
/tmp/pi-bundle/run.sh --list-models          # smoke (lm-studio models appear)
cd /tmp && /tmp/pi-bundle/run.sh -p "hi"     # runs from any cwd
```

## Doctor (self-check)

`doctor` runs offline (no model call) and checks the boundary conditions up front
so a broken deploy / fresh machine surfaces an actionable checklist instead of an
opaque runtime error:

```bash
bun src/cli.ts doctor            # source mode
bun src/cli.ts doctor --smoke    # + runtime probe (actually load the extensions)
./run.sh doctor                  # any deployed layout (bundle/portable/release)
bun src/cli.ts doctor --json     # machine-readable
```

It detects the deploy mode (source/bundle/portable/release/binary), verifies the
entry + extension set are complete for that mode, checks the host can resolve the
deps pi's loader needs (`typebox` + `@earendil-works/*` — FAIL for `--portable`
where the node_modules subset is essential, WARN for THIN bundle which works via
abs paths, INFO for source where pi resolves its own), reports provider apiKey
availability, and lists which patches would apply. Exit 0 = all hard checks pass,
1 = any failed.

### `doctor --smoke` — actually load the extensions

The checks above are all **static** (filesystem / config) — they prove the
extension FILES exist, not that pi loads them. Add `--smoke` and doctor spawns a
throwaway probe that calls `pi.getAllTools()` at `session_start` and counts how
many tools came from the run-dir extension root. It runs **offline** (the probe
exits at `session_start`, before the model call):

```bash
bun src/cli.ts doctor --smoke     # + runtime smoke
./run.sh doctor --smoke           # any deployed layout
```

This catches the **silent-no-op class** the static checks miss — e.g. the #182
regression where `cli.ts` captured `process.argv` *before* the run-dir patch
spliced the `-e` paths in, so every run-dir extension silently failed to load
while every static check stayed green (`total=8 matched=0` instead of `~38
matched=25`). A smoke `matched=0` is a hard FAIL with an actionable hint.
Default doctor stays pure/offline/fast — `--smoke` is opt-in (it spawns a
subprocess). Skipped (INFO) for the compiled binary, which can't load `.ts`.

## Add your own patch

1. Create `src/patches/<name>.ts` that patches a prototype/module.
2. Register it (env-gated) in `src/patches/index.ts`.

`cli.ts` never needs to change.

## Testing

`run-test.sh` is a multi-effort-level launcher — each level is a superset of the
one below (cost is driven by the build + deploy, not the tests):

```bash
./run-test.sh                  # = medium  (~5s)  unit + build + patch e2e   [default]
./run-test.sh quick            # (~0.2s)   unit only, no build — pre-commit safe
./run-test.sh high             # (~18s)    + deploy + 4-cwd extension-loading e2e
./run-test.sh full             # (~35s)    + sibling pi-* unit baseline (whole stack)
./run-test.sh --list           # print the tier table
```

| Level | Adds | Catches |
|---|---|---|
| **quick** | unit (pure fn + import-time smoke) | decision-logic regressions |
| **medium** | build bundle + patch e2e (`--help`/`--list-models` spawns) | patch module dropped from bundle, env→argv splice, **providers not injected** |
| **high** | deploy + 4-cwd extension-loading e2e (was `scripts/verify.ts`) | cwd-coupled extension loader, deploy-package conflicts |
| **full** | sibling pi-* unit baseline (obs/kc/cli/vlm) | the whole stack pi-agent loads as extensions |

Plain `bun test` is the `quick` tier (the e2e files skip themselves without
`PI_AGENT_E2E=1`). medium+ force a fresh build so a stale `dist/` can't mask a
bundle regression. Extra flags are forwarded to `bun test`
(`./run-test.sh high --bail`). Numeric aliases `0-3` work too.

The bundle e2e lives in `src/__tests__/e2e-*.test.ts`; the two env gates it reads
are `PI_AGENT_E2E=1` (patches) and `PI_AGENT_E2E_DEPLOY=1` (extensions).
`bun run verify` runs just the extension-loading e2e (high-tier subset).

## Layout

```
pi-agent/
├── package.json            # bin: pi-agent → src/cli.ts; also holds the migrated npm extension deps
├── README.md
├── run-dir/
│   ├── manifest.json          # this repo's fixed extension/skill list (eager; edit this)
│   ├── settings.json          # lazy/opt-in extension aliases (loaded only via -e <alias>)
│   └── resolve.ts             # resolves manifest.json + lazy aliases to absolute argv
└── src/
    ├── cli.ts                    # applyPatches() → main(argv)
    ├── pre-load-providers.ts     # PROVIDERS config + patch logic (edit this)
    ├── generated/                # build-time-baked constants (gitignored)
    ├── patches/
    │   ├── index.ts                    # registry (env-gated) + debug
    │   ├── default-model-env.ts        # bridges PI_MODEL/PI_PROVIDER/PI_THINKING into argv
    │   └── load-run-dir-resources.ts   # splices run-dir/ into argv
    └── __tests__/
        ├── e2e-harness.ts              # shared build + spawn helpers (PI_AGENT_E2E gate)
        ├── e2e-patches.test.ts         # bundle e2e: every patch fires + env→argv splice
        └── e2e-extensions.test.ts      # bundle e2e: extension loading across cwd/mode (was verify.ts)
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
