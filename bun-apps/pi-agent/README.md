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
This repo's fixed extension/skill set (pi-obsidian, pi-file2md, zai-mcp, etc.) is baked in via
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
bun install          # from bun-apps/ (the workspace root; never inside pi-agent/)
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
See [docs/HISTORY.md](docs/HISTORY.md) for the full development history of all patches.
| Env | Default | Effect |
|-----|---------|--------|
| `BUN_PI_PRE_LOAD_PROVIDERS` | `1` (on) | Inject all providers defined in `src/pre-load-providers.ts` |
| `BUN_PI_SET_PACKAGE_DIR` | `1` (on) | Pin `PI_PACKAGE_DIR` for asset/theme resolution in bundle mode |
| `BUN_PI_SKIP_UPDATE_CHECK` | `1` (on) | Silence pi's "Update Available" banner for bundle/binary (source mode keeps it) |
| `BUN_PI_LOAD_RUN_DIR` | `1` (on) | Splice `run-dir/`'s extensions/skills into argv as absolute `-e`/`--skill` paths |
| `BUN_PI_DEFAULT_MODEL_ENV` | `1` (on) | Bridge `PI_MODEL` / `PI_PROVIDER` / `PI_THINKING` env into argv as `--model` / `--provider` / `--thinking` when not already passed — the real pi TUI ignores these env vars (only the `cli` subcommands read them); this makes a shell `PI_MODEL=…` default apply to the interactive TUI too |
| `BUN_PI_EXT_CTX_GET_SYSTEM_PROMPT_OPTIONS` | `1` (on) | Monkey-patch `ExtensionRunner.createContext()` to expose `getSystemPromptOptions()` on base `ExtensionContext` |
| `BUN_PI_EXT_API_GET_ALL_TOOL_DEFS` | `1` (on) | Monkey-patch `ExtensionRunner.bindCore()` to expose `getAllToolDefinitions(): ToolDefinition[]` on the ExtensionAPI (`pi`) object |
| `BUN_PI_EXTRACT_EMBEDDED_ASSETS` | `1` (on) | Extract embedded assets from the `--exe` binary to cache dir (no-op in non-binary modes) |
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
`../pi-agent-ext-devops/scripts/lib/codegen.ts` (which bakes resolved paths into the bundle).
> `rpiv-todo` is intentionally NOT in `npmExtensions`: this user's global
> `~/.pi/agent/settings.json` already loads it, so a second copy here crashes
> with `Tool "todo" conflicts`. Another clone/environment must add it to their
> OWN `~/.pi/agent/settings.json` to get the `todo` tool.
### Lazy / opt-in extensions (`-e <alias>`)
Everything in `manifest.json` above loads **every** session — fine for cheap,
general-purpose extensions, wrong for heavy on-demand ones (e.g.
`pi-agent-ext-workflow`'s `workflow` tool costs ~2.5k tok/req). Those live in a
separate **lazy registry** — the `lazyExtensions` field of the same
`run-dir/manifest.json` (there is no `run-dir/settings.json`; the old
`settings.json` was consolidated into the manifest):
```json
{ "lazyExtensions": { "workflow": "pi-agent-ext-workflow/extensions/workflow.ts", … } }
```
A lazy entry costs **zero** context unless you ask for it by alias:
```bash
# default session: dynamic-workflows NOT loaded (no token cost)
bun bun-apps/pi-agent/src/cli.ts -p "…"
# opt in for one invocation — the alias resolves to the real factory file
bun bun-apps/pi-agent/src/cli.ts -e workflow -p "audit src/ for missing auth"
bun bun-apps/pi-agent/src/cli.ts -e dynamic-workflows -p "…"
# Note: the MLX extensions (flux2, krea2, ltx) are NOT lazy — they are in the
# always-loaded `extensions[]` list, so the `flux2`/`krea2`/`ltx` tools are
# available every session without an `-e` flag.
```
`run-dir/resolve.ts` rewrites `-e <alias>` to the absolute path before `main()`
sees argv. Resolution (first hit wins): exact alias key (case-insensitive) →
unique substring match (ambiguous → no guess, defers to SDK) → directory
fallback (`<bun-apps>/<alias>/extensions/` with exactly one `.ts`). Real paths
and URL schemes (`npm:`, `git:`, `file:`, `./…`, `/abs/…`) are passed through
untouched, so `-e /real/path.ts` still works. To register a new opt-in
extension, add one line to `run-dir/manifest.json`'s `lazyExtensions` object.
### Flag semantics: `-ne` / `-ns`
User-passed `-ne`/`--no-extensions` and `-ns`/`--no-skills` are honored by the
wrapper (since 2026-07-19):
- `-ne` — suppresses BOTH injection channels: the run-dir `-e` splice
  (`src/patches/load-run-dir-resources.ts`) and the static factories
  (`src/cli.ts` passes `[]` to `main()`). Your own explicit `-e <path>` still
  loads — same as upstream pi, where `-ne` + explicit `-e` means "only this
  extension".
- `-ns` — suppresses the run-dir `--skill` splice. Your own `--skill <path>`
  still loads.
- Deploy layouts still self-inject `-ne` internally (run-dir/resolve.ts) so a
  deployed pi-agent ignores whatever `.pi/` exists in your cwd. That injected
  flag is invisible to the user-flag detection, which reads argv BEFORE the
  splice happens.
Detection lives in `src/cli-argv.ts` (`userSuppressFlags`); filtering lives in
`run-dir/resolve.ts` (`suppressResolvedArgv`).
## Cross-machine portability
The run-dir mechanism makes extension loading cwd-independent, but a fresh machine still
needs its env-var contract in place (`MLX_MODELS_DIR`, `MLX_OUTPUT_DIR`, `OB_VAULT_PATH`,
…). The canonical reference + setup steps live in
[`docs/pi-cross-machine-setup.md`](docs/pi-cross-machine-setup.md), and
The `cli` subcommand tree ships a `doctor` self-check that verifies everything is wired:
```bash
bun bun-apps/pi-agent/src/cli.ts cli doctor [--json]
```
## Build / Deploy modes
pi-agent ships via four deploy modes, all driven by `../pi-agent-ext-devops/scripts/deploy.ts`.
See the [Deploy](#deploy) section for full details.
```bash
bun ../pi-agent-ext-devops/scripts/deploy.ts                    # --bundle (default): thin bundles + node_modules symlink (same-machine)
bun ../pi-agent-ext-devops/scripts/deploy.ts --exe              # single self-contained executable (all assets embedded, ~75 MB)
bun ../pi-agent-ext-devops/scripts/deploy.ts --snapshot         # full source copy + node_modules symlink tree (same-machine)
bun ../pi-agent-ext-devops/scripts/deploy.ts --standalone       # bundle + local bun binary + run.sh (same-machine)
bun ../pi-agent-ext-devops/scripts/deploy.ts --no-freeze        # skip read-only freeze
bun run deploy:exe                       # shorthand for --exe
```
The sourcemap is **opt-in** — the `.map` is ~20 MB (embeds full source) and is
never shipped (`deploy.ts` copies only `pi-agent.js`), so it's off by default.
Pass `--sourcemap` when debugging the bundle in place.
Building also generates `src/generated/run-dir-base.ts` (gitignored) — `BUN_APPS_DIR`
and pre-resolved npm-extension paths, baked in because `import.meta.dir` reflects the
*bundle's* location once built, not the original source file's. **Portability
caveat**: this makes the bundle work from any invocation directory *on the machine it
was built on* (same trade-off the existing `PI_PKG_DIR`/node_modules-symlink pattern
already accepts) — not relocatable to a different host/filesystem layout unless
`bun-apps/` is copied to the identical absolute path there too.
### Standalone binary (`--exe`)
`run-dir/manifest.json`'s normal `-e <path>.ts` extension loading is jiti-based
(runtime TS transpilation): in `isBunBinary` mode jiti feeds each extension as
a `data:text/javascript;base64,…` URL, and Bun's compiled resolver rejects it
with `NameTooLong` (`ENAMETOOLONG`). That's a bun-compile + jiti limitation,
not a pi-agent bug, and it can't be worked around for extensions loaded that
way — `run-dir/resolve.ts` detects binary mode and never emits `-e` at all.
To still ship *some* extensions in the binary, the static extension set (`run-dir/manifest.json` → `staticExtensions`, mirrored by `src/static-extensions.ts`) —
are **statically imported** instead, in `src/static-extensions.ts`:
```
Group A (original "general productivity" set):
  pi-agent-ext-core-task · pi-agent-ext-prompt-history · pi-agent-ext-hermes-memory
  pi-agent-ext-superpowers · pi-agent-ext-wayfind · pi-agent-ext-web-access
Group B (migrated from dynamic `-e`, tool-providing):
  pi-agent-ext-obsidian · pi-agent-ext-btw · pi-agent-ext-file2md
  pi-agent-ext-subagent · pi-agent-ext-workflow · pi-agent-ext-knowledge-card
  pi-agent-ext-power-tool
```
A static `import` is a native in-memory reference (no jiti involved), so
`bun build --compile` inlines it into the executable like any other code —
`main(argv, { extensionFactories: STATIC_EXTENSION_FACTORIES })` registers
them without ever touching the `-e` path. These 13 are deliberately **absent**
from `manifest.json`'s `extensions` array (keeping both would double-register
them — a jiti-loaded module and a natively-imported module aren't guaranteed
to be the same module identity) but four of them — hermes-memory, superpowers,
wayfind, web-access — keep `binarySkills` entries there: their skill directories
are plain markdown (no jiti/dynamic code
involved), so `../pi-agent-ext-devops/scripts/deploy.ts`'s `--exe` mode ships them as sibling dirs
next to the exe (`dist/pi-agent/<ext>/skills/`), and `resolve.ts` still emits
`--skill <path>` for them in binary mode.
Everything else in `manifest.json` (movie-director, flux2, research-tool, …)
is **not available in the compiled binary**. Use source or bundle mode for
those, or run the binary with `-ne` for a clean start with zero injected
extensions (see "Flag semantics: `-ne` / `-ns`" below).
```bash
bun run deploy:exe                          # build dist/pi-agent/pi-agent
dist/pi-agent/pi-agent --version
dist/pi-agent/pi-agent doctor --json       # mode:"binary", ok:true
bun src/cli.ts ext doctor --json           # verify every static factory registers (source-mode check;
                                            # the binary's own `ext doctor` isn't binary-mode-aware)
```
CI's `compile-verify` job (`.github/workflows/ci.yml`) builds the binary on
every `pi-agent`-touching PR and asserts: `doctor --json` is healthy, all 13
static extensions (6 Group A productivity + 7 Group B tool-providing) register with
0 conflicts, all 4 `binarySkills` paths resolve, and obsidian's module body
IS inlined into the compiled binary (`strings … | grep -c obsidian_list`
must be `>0`) — proving Group B's static imports actually got bundled, not
silently dropped.
See [`docs/deploy-single-binary.md`](docs/deploy-single-binary.md) for the
full rationale (why `require()` doesn't work, why some files carry
`// @ts-nocheck`, the `manifest.json` field reference) and the steps to add
or remove an extension from this static set.
## Deploy
`../pi-agent-ext-devops/scripts/deploy.ts` packages pi-agent + its extension set into a dir runnable from **any cwd on the build machine**. Only `--exe` is fully self-contained/portable; the other three modes rely on a `node_modules` symlink (Bundle/Standalone) or a copied symlink tree (Snapshot) into the machine-global bun store, so they are **same-machine only**.
| Mode | Command | Layout | node_modules | Portable? |
|------|---------|--------|-------------|-----------|
| **Bundle** (default) | `bun ../pi-agent-ext-devops/scripts/deploy.ts` | `pi-agent.js` + `ext-bundles/*.thin.js` + `skills/` | symlink → global store | same-machine only |
| **Snapshot** | `bun ../pi-agent-ext-devops/scripts/deploy.ts --snapshot` | Full source tree + sibling ext pkgs + `run.sh` | copied symlinks → global store | same-machine only |
| **Standalone** | `bun ../pi-agent-ext-devops/scripts/deploy.ts --standalone` | Bundle + `bun` binary + `run.sh` | symlink → global store | same-machine only (no system `bun` needed) |
| **Exe** | `bun ../pi-agent-ext-devops/scripts/deploy.ts --exe` | Single executable (~75 MB) | none (all embedded) | **yes — fully self-contained** |
See [`docs/deploy-cwd-trust.md`](docs/deploy-cwd-trust.md) for the packaging/mode-detection details and [`docs/deploy-single-binary.md`](docs/deploy-single-binary.md) for the `--exe` rationale — why extensions can't load in binary mode, how the static extension set works, the `@ts-nocheck` pattern, and how `--exe` packs all assets into one file.
### Read-only deploy (the default)
A deploy is an **immutable artifact**: code + bundled extensions, with ALL
per-user state routed to `~/.pi/agent`. Both pi itself (`getAgentDir()` →
`PI_CODING_AGENT_DIR`, default `~/.pi/agent`) and `pi-hermes-memory` (its sqlite
DB honors the same env) write there — never into the deploy tree. So freezing
the tree costs nothing at runtime, and `deploy.ts` does it automatically:
- **`chmod -R a-w`** the out-dir, and
- writes a **`.deploy-readonly`** marker.
The result drops onto `/opt`, an app bundle, or any read-only prefix as-is.
`run.sh` reads the marker and applies the env hardening that makes a frozen
deploy actually run:
| env | value | why |
|---|---|---|
| `JITI_FS_CACHE` | `0` (if unset) | `--snapshot` ships `.ts` source loaded by jiti at runtime; jiti's fs cache would otherwise write into the frozen tree (defensive — the current jiti version's unset default is already no-FS-cache) |
| `PI_CODING_AGENT_DIR` | `$HOME/.pi/agent` (if unset) | pins per-user state to a writable dir, never the deploy tree |

```bash
bun ../pi-agent-ext-devops/scripts/deploy.ts /opt/pi-agent           # frozen by default (chmod a-w + marker)
sudo chown -R root:wheel /opt/pi-agent        # now truly immutable to non-root
cd ~/project && /opt/pi-agent/run.sh          # runs; state → ~/.pi/agent
/opt/pi-agent/run.sh doctor --smoke           # proves extensions load despite the freeze
bun ../pi-agent-ext-devops/scripts/deploy.ts /tmp/dev-deploy --no-freeze   # opt OUT of the freeze (iteration/cleanup)
```
Two contract rules for a read-only deploy: invoke `run.sh` from a **non-deploy
cwd** (so `<cwd>/.pi` isn't the frozen tree), and keep `PI_CODING_AGENT_DIR` on a
writable path (the default `~/.pi/agent` is fine). The read-only contract is
guarded by `../pi-agent-ext-devops/scripts/run-test.sh readonly` — it freezes a deploy, runs `doctor` +
`--smoke` from a foreign cwd, and asserts **zero files** are written into the
frozen tree.
## Doctor (self-check)
`doctor` runs offline (no model call) and checks the boundary conditions up front
so a broken deploy / fresh machine surfaces an actionable checklist instead of an
opaque runtime error:
```bash
bun src/cli.ts doctor            # source mode
bun src/cli.ts doctor --smoke    # + runtime probe (actually load the extensions)
./run.sh doctor                  # any deployed layout (bundle/snapshot/standalone/exe)
bun src/cli.ts doctor --json     # machine-readable
```
It detects the deploy mode (source/bundle/snapshot/standalone/exe), verifies the
entry + extension set are complete for that mode, checks the host can resolve the
deps pi's loader needs (`typebox` + `@earendil-works/*` — FAIL for `--snapshot` / `--standalone`
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
./run.sh doctor --smoke           # any deployed layout (bundle/snapshot/standalone)
```
This catches the **silent-no-op class** the static checks miss — e.g. the #182
regression where `cli.ts` captured `process.argv` *before* the run-dir patch
spliced the `-e` paths in, so every run-dir extension silently failed to load
while every static check stayed green (`total=8 matched=0` instead of `~38
matched=25`). A smoke `matched=0` is a hard FAIL with an actionable hint.
Default doctor stays pure/offline/fast — `--smoke` is opt-in (it spawns a
subprocess). Skipped (INFO) for the compiled binary, which can't load `.ts`.
### `doctor --fix` — REMOVED

`--fix` used to derive a fix plan and run `bun install` in the deploy dir. It
never ran: its planner gated on `portable` / `release`, deploy modes nothing can
produce, so it always printed *nothing to fix* — which reads as "your deploy is
healthy".

Re-homing it onto `--snapshot` (what this section used to document) was tried
and rejected on evidence: a snapshot is not a workspace, so `bun install` inside
its deploy dir fails on every `workspace:*` dependency.

**A deploy artifact is not repairable in place — re-deploy it.** Every check
that can detect a broken deploy says so in its hint.

## Add your own patch
1. Create `src/patches/<name>.ts` that patches a prototype/module.
2. Register it (env-gated) in `src/patches/index.ts`.
`cli.ts` never needs to change.
## Testing
`run-test.sh` (now living at `../pi-agent-ext-devops/scripts/run-test.sh`)
is a multi-effort-level launcher — each level is a superset of the
one below (cost is driven by the build + deploy, not the tests):
```bash
../pi-agent-ext-devops/scripts/run-test.sh                  # = medium  (~11s)  unit + build + patch e2e   [default]
../pi-agent-ext-devops/scripts/run-test.sh quick            # (~0.2s)   unit only, no build — pre-commit safe
../pi-agent-ext-devops/scripts/run-test.sh high             # (~46s)    + deploy + 4-cwd extension-loading e2e (bundle/snapshot/standalone)
../pi-agent-ext-devops/scripts/run-test.sh readonly         # (~6s)     read-only deploy e2e ONLY (freeze + zero-write contract)
../pi-agent-ext-devops/scripts/run-test.sh full             # (~70s)    + readonly + sibling pi-* unit baseline (whole stack)
../pi-agent-ext-devops/scripts/run-test.sh --list           # print the tier table
```
| Level | Adds | Catches |
|---|---|---|
| **quick** | unit (pure fn + import-time smoke) | decision-logic regressions |
| **medium** | build bundle + patch e2e (`--help`/`--list-models` spawns) | patch module dropped from bundle, env→argv splice, **providers not injected** |
| **high** | deploy + 4-cwd extension-loading e2e (was `scripts/verify.ts`) | cwd-coupled extension loader, cross-deploy-mode conflicts |
| **readonly** | frozen-deploy e2e (chmod a-w + foreign-cwd `doctor`/`--smoke` + zero-write assertion) | a patch/extension that writes into the deploy tree; run.sh losing the `JITI_FS_CACHE=0`/`PI_CODING_AGENT_DIR` hardening |
| **full** | sibling pi-* unit baseline (obs/kc/cli/vlm) | the whole stack pi-agent loads as extensions |
Plain `bun test` is the `quick` tier (the e2e files skip themselves without
`PI_AGENT_E2E=1`). medium+ force a fresh build so a stale `dist/` can't mask a
bundle regression. Extra flags are forwarded to `bun test`
(`../pi-agent-ext-devops/scripts/run-test.sh high --bail`). Numeric aliases `0-3` work too.
The bundle e2e lives in `src/__tests__/e2e-*.test.ts`; the two env gates it reads
are `PI_AGENT_E2E=1` (patches) and `PI_AGENT_E2E_DEPLOY=1` (extensions).
`bun run verify` runs just the extension-loading e2e (high-tier subset).
## Layout
```
pi-agent/
├── package.json            # bin: pi-agent → src/cli.ts; also holds the migrated npm extension deps
├── README.md
├── run-dir/
│   ├── manifest.json          # this repo's fixed extension/skill list (eager; edit this) + lazyExtensions aliases
│   └── resolve.ts             # resolves manifest.json extensions + lazy aliases to absolute argv
├── scripts/
│   ├── generate-embedded-assets.ts  # codegen for --exe's embedded theme/skills/assets
│   ├── run-ext-e2e.sh / run-image-agent-e2e.sh / run-self-improve-loop.sh  # opt-in runner scripts
│   └── (deploy.ts + lib/ moved to ../pi-agent-ext-devops/scripts/ — see #1305)
└── src/
    ├── cli.ts                    # entry — `cli` argv intercept, then applyPatches() → main(argv)
    ├── pre-load-providers.ts     # PROVIDERS config, pure, no side effects (edit this)
    ├── generated/                # build-time-baked constants (gitignored)
    ├── cli/                      # the non-interactive `pi-agent cli` namespace
    │   ├── dispatch.ts               # command table + meta/passthrough routing (runCli)
    │   ├── args.ts / flag-spec.ts    # pi-CLI-aligned argument parser
    │   ├── commands/                 # one file per agent command / pipeline / workflow sub-command
    │   ├── extensions/               # registry.ts + runner.ts for the NL→tool sub-commands
    │   └── sessions/                 # shared.ts (baked-in factories + registry) + passthrough.ts
    ├── patches/
    │   ├── index.ts                    # registry (env-gated) + debug
    │   ├── pre-load-providers.ts       # the actual ModelRegistry.loadModels monkey-patch
    │   ├── default-model-env.ts        # bridges PI_MODEL/PI_PROVIDER/PI_THINKING into argv
    │   └── load-run-dir-resources.ts   # splices run-dir/ into argv
    └── __tests__/
        ├── e2e-harness.ts              # shared build + spawn helpers (PI_AGENT_E2E gate)
        ├── e2e-patches.test.ts         # bundle e2e: every patch fires + env→argv splice
        └── e2e-extensions.test.ts      # bundle e2e: extension loading across cwd/mode (was verify.ts)
```
## Known issues
- **Standalone binary can't dynamically `-e`-load `.ts` extensions**
  (`./dist/pi-agent/pi-agent`). In `isBunBinary` mode, jiti feeds each
  extension as a `data:text/javascript;base64,…` URL; Bun's compiled
  resolver treats it as a path and fails with `NameTooLong` (`ENAMETOOLONG`).
  This is a bun-compile + jiti limitation, not a pi-agent regression, and it
  can't be fixed for extensions loaded that way. **The static extension set
  sidesteps this** by being statically imported instead (see
  [Standalone binary](#standalone-binary---exe) above /
  [`docs/deploy-single-binary.md`](docs/deploy-single-binary.md)) — the
  binary is not extension-less, just limited to that fixed set. Everything
  else in `manifest.json` needs **source** / **bundle** mode, or run the
  binary with `-ne` for a clean start with zero injected extensions (see
  "Flag semantics: `-ne` / `-ns`" above). Provider injection
  (`pre-load-providers`) works in the binary regardless.
## Non-interactive CLI (`pi-agent cli`)
Everything above is the **interactive TUI** entry. The same package also ships a
second entry namespace, `cli` — non-interactive, scriptable, single-turn. Use it
for one-shot automation, or to call a specific agent workflow from a script.
```bash
./pi-agent.sh cli <command> [options]                    # from the repo root
bun bun-apps/pi-agent/src/cli.ts cli <command> [options]  # same, no wrapper
bun dist/pi-agent/pi-agent.js cli <command>               # deployed bundle
dist/pi-agent/pi-agent cli <command>                      # deployed --exe
```
> The `cli` token is intercepted in `src/cli.ts` **before** `applyPatches()`, so
> a CLI invocation gets none of the TUI's run-dir splice, provider patch, or
> static extension factories. Note `bun run --cwd bun-apps/pi-agent cli` is this
> package's own npm script (`bun src/cli.ts`) and does **not** prepend the token
> — pass it yourself, or use one of the four forms above.
Every invocation is a **non-interactive run** (one process, no TUI, no persistent
session loop). Of these, the agent commands and the passthrough are **single-turn
agent runs**; the meta commands (`list`, `version`, `completions`, `help`) and
`workflow run` are non-interactive but **not** agent runs. Vocabulary:
[CONTEXT.md § Non-interactive CLI](CONTEXT.md#non-interactive-cli).
### Baked-in extensions (not run-dir)
The `cli` namespace imports extension factories **directly** (`src/cli/sessions/shared.ts`),
rather than loading `run-dir/manifest.json`. `pi-obsidian` is **always-on** (every
session gets the `obsidian` tools); everything else is **per-command**, injected
only by the command that needs it. The TUI eagerly loads the whole manifest
because a user may want any tool mid-session; a single-turn CLI run **curates
tools per command** (e.g. `zk-extract` passes only the distill allowlist), and
loading the full manifest would bloat every run with extensions it never uses.
Both paths resolve to the same underlying factories — only the load mechanism
differs. Rationale: [ADR 0001](docs/adr/0001-extensions-baked-in-not-manifest.md).
### Agent commands (each is a single-turn agent run)
```bash
./pi-agent.sh cli chat                        # interactive multi-turn REPL
./pi-agent.sh cli agent <task...>             # free-form agentic task, broad toolset
./pi-agent.sh cli file2md <files...>          # PDF/image → Obsidian markdown (local VLM)
./pi-agent.sh cli zk-extract <files/folders>  # markdown → Zettelkasten atomic notes
./pi-agent.sh cli zk-card <add|find|update|remove|check>
./pi-agent.sh cli zk-ask <question>           # graph-enhanced RAG answer
./pi-agent.sh cli zk-ingest --source <src>    # converge .knowledge.jsonl → cards
./pi-agent.sh cli zk-query <query>            # deterministic tag-ranked digest
./pi-agent.sh cli sessions <query>            # search past session transcripts
./pi-agent.sh cli memory <query>              # search pi-hermes-memory
./pi-agent.sh cli doctor [--json] [--fix]     # cross-machine portability self-check
./pi-agent.sh cli list | list-tools | version | completions <bash|zsh|fish>
./pi-agent.sh cli help [command]
```
`./pi-agent.sh cli help` prints the authoritative list; `help <command>` prints
one command's flags.
#### `file2md` — PDF/image → Obsidian markdown
Rasterizes each PDF page (macOS PDFKit) / accepts images, classifies a profile
via a local VLM, then explains each page into per-page Obsidian markdown +
`manifest.json` + a doc-level MOC. Default model:
`lm-studio/google/gemma-4-26b-a4b-qat` (local VLM via LM Studio).
```bash
./pi-agent.sh cli file2md paper.pdf --pages 1-3 --out ./vlm-out
./pi-agent.sh cli file2md scan.jpg --type image --dpi 200
```
#### `zk-extract` — markdown → Zettelkasten
Distills input markdown/text into atomic notes in an Obsidian vault. Folders are
scanned recursively for `*.md` / `*.txt`.
```bash
./pi-agent.sh cli zk-extract ./inbox/ --folder Zettelkasten --max-notes 20
```
### Extension-backed sub-commands (NL → tool)
These wrap a per-command extension's tool behind a natural-language prompt.
```bash
./pi-agent.sh cli flux2 <request...>       # images (Flux2 Klein, Swift/MLX)
./pi-agent.sh cli krea2 <request...>       # images (Krea 2 Turbo, Swift/MLX)
./pi-agent.sh cli ltx <request...>         # video (LTX-2.3, Swift/MLX)
./pi-agent.sh cli movie <request...>       # video-production orchestrator
./pi-agent.sh cli research <query...> [--save]   # web research → digest
./pi-agent.sh cli power-tool <request...>  # runtime diagnostics
```
The registry lives at `src/cli/extensions/registry.ts`.
### Pipelines (multi-stage, resumable)
A pipeline orchestrates several agent commands in-process, under a `pipeline.json`
coordination layer in a timestamped run dir. Re-run with the same `--out` + input
to resume — completed stages/pages are skipped.
```bash
./pi-agent.sh cli pipeline pdf-to-vault <pdf> [--pages 1-3] [--delete-png]
./pi-agent.sh cli pipeline image-to-vault <image>
./pi-agent.sh cli pipeline url-to-vault <url>
./pi-agent.sh cli pipeline youtube-to-vault <url> [question]
./pi-agent.sh cli pipeline memory-to-vault
./pi-agent.sh cli pipeline status|run|dry-run|lint   # knowledge pipeline
```
### Workflow sub-command (headless engine, no agent session)
```bash
./pi-agent.sh cli workflow list                       # [pack] vs [file]
./pi-agent.sh cli workflow run <name|path> [--dry-run] [--json]
```
This is the structural exception to "every command is an agent run": it calls
`runWorkflow()` directly and creates no session of its own. Reference:
[`docs/workflow-cli.md`](docs/workflow-cli.md). Pack name-resolution precedence:
[ADR 0008](docs/adr/0008-portable-workflow-pack-discovery.md).
### Passthrough
Anything that isn't a known command token after `cli` is treated as a pi agent
invocation (mirrors `pi -p` / `pi --mode json`):
```bash
./pi-agent.sh cli -p "What files are in the current directory?"
./pi-agent.sh cli --model deepseek-v4-flash -p "Summarize this"
./pi-agent.sh cli --mode json --no-session --tools read,bash "summarize"
```
This is exactly what the `obsidian_distill` / `obsidian_garden` subagent tools
invoke internally (`process.argv[1]` + pi flags), which is why it exists: pi-agent
is its own sub-agent target. `runCli()` exports `PI_SELF_ENTRY_PREFIX=cli` so a
child spawned from a `cli` parent re-enters the `cli` namespace, not the TUI root.
Rationale: [ADR 0002](docs/adr/0002-passthrough-is-self-subagent-target.md).
### CLI flags (pi-aligned)
| Flag | Description |
|------|-------------|
| `--model <pattern>` | `id`, `provider/id`, or `provider/id:thinking` (fuzzy) |
| `--provider <name>` | provider name |
| `--thinking <level>` | `off\|minimal\|low\|medium\|high\|xhigh` |
| `--api-key <key>` | API key |
| `--mode <text\|json>` | output mode (default: `text`) |
| `-p`, `--print` | non-interactive one-shot |
| `-V`, `--verbose` | tool verbosity: show args (repeat: `-VV` = debug) |
| `--debug` | alias for `-VV` |
| `--no-session` | ephemeral (in-memory) session |
| `--tools`, `-t <csv>` | tool allowlist |
| `--exclude-tools`, `-xt <csv>` | tool denylist |
| `--append-system-prompt <x>` | text or file path (repeatable) |
| `--dry-run` | suppress vault writes (excludes the write tools — see [ADR 0006](docs/adr/0006-dry-run-excludes-write-tools.md)) |
| `-e`, `--extension <path>` | accepted, ignored (extensions baked in) |
| `-a`, `--approve` | accepted, ignored (self-trusted) |
| `--` | end-of-options — the rest passes through verbatim (`flux2 -- t2i --prompt "…"`) |
### CLI runtime environment
Distinct from the `BUN_PI_*` patch toggles above — those gate the TUI's
monkey-patches, which a `cli` invocation never applies.
| Var | Purpose |
|-----|---------|
| `PI_PROVIDER` / `PI_MODEL` / `PI_THINKING` | LLM overrides (the `cli` commands read these directly) |
| `PI_SKIP_MODELS_JSON` | `1` → hermetic in-memory registry, baked providers only |
| `PI_SELF_ENTRY_PREFIX` | set to `cli` by `runCli()` so child sub-agents re-enter the same namespace |
| `OB_VAULT_PATH` | absolute vault path |
| `OB_VAULT_DIR` | vault folder name under cwd (default: `vault`) |
| `OB_SUBAGENT_TIMEOUT_MS` | distill subagent timeout (default: `300000`) |
| `OB_PARENT_MODEL` / `OB_SUBAGENT_MODEL` | publish the parent's model to children / floor children onto a fast model |
| `PI_WORKFLOWS_OUT_DIR` | workflow run-log dir (default `PWD/.pi/workflows/runs/`) |
Model/credentials otherwise come from your existing pi config
(`~/.pi/agent/settings.json`, `auth.json`, `models.json`); the baked provider
catalog is layered on top — see [ADR 0005](docs/adr/0005-provider-catalog-from-pi-agent.md).
### CLI docs
- [`docs/cli-PRD.md`](docs/cli-PRD.md) — product requirements + the agent knowledge stack
- [`docs/KNOWLEDGE-LAYER.md`](docs/KNOWLEDGE-LAYER.md) — what the 5 `zk-*` commands import
- [`docs/workflow-cli.md`](docs/workflow-cli.md) — headless workflow-engine runner
- [`docs/cli-VERIFICATION.md`](docs/cli-VERIFICATION.md) — historical e2e verification report
- [`docs/adr/`](docs/adr/) — 8 ADRs covering the CLI's design decisions
