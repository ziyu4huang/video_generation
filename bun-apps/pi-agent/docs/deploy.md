# deploy — versioned minimal-core deploy

A second, independent deploy pipeline. It builds a **minimal `pi-agent` executable with zero
extensions compiled in**, plus **extension packages built separately** into `ext/<name>/`, all
under a versioned directory. The core discovers extensions at runtime; delete `ext/` and it still
boots, just without them.

This pipeline does not touch the four modes in `../pi-agent-ext-devops/scripts/deploy.ts`
(`--bundle` / `--snapshot` / `--standalone` / `--exe`), which keep working exactly as before.

## Layout

```
~/proj/dist/pi-agent-sh/
  current -> 0.1.0+g520acb9/          # flipped only after every gate passes
  0.1.0+g520acb9/
    pi-agent            # compiled minimal core (~70 MB)
    run.sh              # launcher: env hardening + exec ./pi-agent
    deploy.json         # provenance: version, builtAt, git sha, bun version, config snapshot
    package.json        # {"version": ...} — pi reads its version from next to the exe
    ext/
      task/       ext.json  ext.cjs                    (~160 KB)
      power-tool/ ext.json  ext.cjs                    (~215 KB)
                   node_modules/playwright-core/…      (vendored, ~13 MB)
```

Version string: `<pi-agent package.json version>+g<git short sha>`. The executable locates its own
tree via `dirname(process.execPath)` — no repo path is baked in. In compiled-binary mode pi also
resolves its reported version from that directory's `package.json` (hence the deployed one); without
it the banner reads `pi v0.0.0`.

## Commands

```bash
bun run --cwd bun-apps/pi-agent deploy:sh                  # full deploy
bun run --cwd bun-apps/pi-agent deploy:sh --ext power-tool # rebuild ONE extension in place
bun run --cwd bun-apps/pi-agent deploy:sh --list           # versions + current target
~/proj/dist/pi-agent-sh/current/run.sh                     # run it
~/proj/dist/pi-agent-sh/current/pi-agent --ext-list        # what loaded, what was skipped, and why
```

Other flags: `--config <path>`, `--out <dir>`, `--version <str>`, `--force`, `--no-freeze`,
`--no-current`. stdout is pure JSON; exit 0 = ok, 1 = failure, 2 = usage error.

`--ext` requires the version dir to already exist: it unfreezes that tree, rebuilds only the named
extensions, re-runs the smoke gate, and re-freezes. Changing one extension does not recompile the
core.

## The host contract

Extension bundles are built `--format=cjs` with pi's runtime marked `--external`, and the core
evaluates each bundle with an injected `require` that serves **its own embedded modules**.

This is not a packaging preference. A bundle that resolves `@earendil-works/pi-tui` from disk gets a
*different module instance* than the one inside the binary (measured: identity check `false`; with
host injection, `true`). `pi-agent-ext-task` builds TUI overlays and keybindings against the host's
running pi-tui, so a second instance breaks identity-sensitive behavior.

Host modules (`src/sh/host-modules.ts`, `HOST_MODULE_IDS`):

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`, `typebox/value`
- `@repo/pi-agent-core-runtime` — holds cross-extension singletons (`SubagentInFlightRegistry`)
  AND the shared dispatch layer (`spawnSubagent`, `roleAwareDirectCall`, the agent-history trace
  renderers); inlining it per-extension would split the singleton

Node/Bun builtins are also served by the injected require. That is required, not a convenience: a
minified bundle calls `require("module")` / `require("child_process")` for its own interop shims
even when the extension source never mentions them.

**Adding a host module means editing two files** — `src/sh/host-modules.ts` (a static
`import * as`, so the compiler embeds it) and `pi-agent.registry.yaml`. The deploy hard-fails when the
two disagree, because a config that promises a module the core does not embed produces extensions
that silently refuse to load.

`hostApi` (currently `2`) is the contract version. Every `ext.json` records the version it was built
against; a mismatch skips that extension with a warning instead of half-loading it.

**2 removed `@repo/pi-agent-ext-subagent` from the host registry.** It had been served because
hermes-memory's background handlers imported `spawnSubagent` / `roleAwareDirectCall` from it — one
extension importing another, resolved by promoting the whole package into the core. Serving an
extension as a library is the shape to avoid: it makes that extension un-removable while looking
like an ordinary entry in `ext/`. The dispatch layer moved to `@repo/pi-agent-core-runtime` (already
a host module, and where the in-flight registry always lived), so subagent is a plain removable
extension again. `bun-apps/tests/extension-isolation-contract.test.ts` (import statements) and
`dep-guard.test.ts` invariant 7 (package.json declarations) now block the regression from both
sides, over the base set derived from this file.

## Adding an extension

Add an entry to `pi-agent.registry.yaml`:

```yaml
  - name: my-ext
    package: pi-agent-ext-my-ext
    entry: extensions/my-ext.ts
    load: static
    skills: true            # optional — copies the package's skills/ dir AND forwards it to pi as --skill paths
    deploy:
      order: 60
      copy: [procedures]    # optional — copied but NOT forwarded (runtime data; see Limits)
      vendor: [some-pkg]    # optional — copy a real node_modules copy per extension (see below)
```

then run `bun run regen:manifest` (the run-dir manifest derives from the registry) and `deploy:sh`. If the build reports foreign specifiers, decide per specifier: a shared
runtime that must be identical to the host's goes in the host whitelist; anything else should be
inlined by the bundler (check the package declares it in its own `package.json` and that
`bun install` has run from `bun-apps/`).

### Vendored packages (`vendor:`)

`vendor:` ships a package as a **real directory** under `ext/<name>/node_modules/<pkg>/` instead of
bundling it. Two reasons, both measured:

- **`__dirname` fidelity** — bun's cjs output rewrites `__dirname` to the path the file had on the
  build machine. playwright-core locates its own resources via `__dirname`; bundling it baked
  `~/.bun/install/cache/...` into the deploy and made the tree non-relocatable.
- **Dynamic imports** — a real `import()` inside a compiled binary resolves against the
  executable's virtual root (`/$bunfs/root/...`) and fails, because it never goes through the
  injected `require`. The build rewrites `import("<vendored>")` to
  `Promise.resolve(require("<vendored>"))`, putting it back on the loader's resolution path, where
  the ext-local `node_modules/` fallback finds the vendored copy (the host module always wins over
  a vendored copy, so vendoring can never shadow the shared runtime or split a singleton).

Vendoring is what took power-tool's `ext.cjs` from ~3.8 MB to ~215 KB, at the cost of the ~13 MB
playwright-core tree beside it.

### Runtime externals

`externals` marks a specifier as neither bundled nor host-provided. An entry ending in `/*` covers
every subpath of that package.

power-tool needs this for playwright: playwright-core's vendored bundle does
`require("chromium-bidi/...")` while declaring zero deps, and references the optional peers
`kerberos`, `vite`, and `@playwright/test`. This is the same treatment `deploy.ts` already applies
via its `OPTIONAL_EXTERNALS` (PR #1635) — only the unresolvable internals are left out. Those live
in esbuild's lazy `__esm({...})` sections that the default CDP path never enters.

`ext.json` records these under `runtimeExternals`, deliberately separate from `hostModules` — one
says the core supplies it, the other says only that it was not bundled.

## Removing / disabling an extension

Three levers, cheapest first — none of them touches the core:

| Lever | Scope | How |
|---|---|---|
| `BUN_PI_<NAME>=0` | one session | `BUN_PI_HERMES_MEMORY=0 run.sh` — the factory returns before registering anything |
| `enabled: false` in `ext/<name>/ext.json` | one deploy | the loader reports it under `skipped` with that reason |
| `rm -rf ext/<name>` | one deploy | the loader never sees it; `--ext-list` shows the smaller set |

`<NAME>` is the short name upper-cased with `-` → `_` (`hermes-memory` → `BUN_PI_HERMES_MEMORY`).
Every base-set extension has one, and
`bun-apps/tests/extension-isolation-contract.test.ts` asserts it registers NOTHING when set —
a knob that silently stopped working is the failure mode this guards. The one exemption is
`hyperframes`, whose factory is a deliberate no-op (its payload is the skills tree, removed by
dropping the `skills:` entry); the guard asserts that exemption is true rather than trusting it.

`-ne` / `--no-extensions` disables ALL of them at once, and is what gate 3 uses.

Removing an extension is safe because no extension imports another: cross-extension coupling goes
through the Pi extension API, a `pi-agent-core-*` package, or a defensively-read `globalThis.__pi*`
seam. The two guards named under "The host contract" above hold that line.

## The four gates

Every deploy runs these; any failure aborts, removes the staging dir, and leaves `current` untouched.

1. **Foreign-specifier scan** — bare specifiers left in a bundle must be a subset of the host
   whitelist plus builtins. A failure means the extension would look fine on disk and fail to load
   on the user's machine.
2. **Load probe** — the freshly built `ext.cjs` is loaded through the *real* loader with the *real*
   host modules. This is what catches a change in bun's cjs output shape at deploy time rather than
   at user runtime. (It resolves host modules with `Bun.resolveSync` from `bun-apps/pi-agent`: the
   workspace's isolated linker keeps them in the global store, where a plain `createRequire` from
   the output dir cannot reach them — an earlier version resolved from there, stubbed everything,
   and proved nothing while passing.)
3. **Dual-state smoke** — `pi-agent --ext-list` must report every configured extension loaded; then
   `ext/` is moved aside and the same command must exit 0 with zero extensions. This is the
   executable proof that the core does not depend on its extensions.
4. **Foreign-path scan** — no string in a bundle may be an absolute path under the builder's home
   or repo (`file://` URLs count — they are paths in disguise). Exemptions: the deploy tree itself
   and `$HOME/.pi` (the agent's per-user state dir, addressed by absolute path on every machine by
   design). This is the gate that would have caught the baked `createRequire("file:///Users/…")`
   base and playwright's build-machine `__dirname`.

## E2E tiers

The gates prove the tree is well-formed; they do not start a session. Three tiers do, in order of
cost:

- **L1 — `tests/deploy-e2e.test.ts` + `tests/deploy-probe-e2e.test.ts`** (both in CI via
  `scripts/check-deploy-e2e.sh`, wired into the `regression-gates` job). The first checks the
  TREE — mode, freeze, version, `current` symlink, ext-only rebuild, the zero-extension state. The
  second runs the deployed binary offline: import-free `-e` probes fire on `session_start`, inspect
  tools/commands/skills/cross-extension seams, and exit before any provider call. Catches
  "registered but dead" (the sdk-patch polyfill was dead in every deploy for a week while every
  gate was green) and "starts dirty" (obsidian reported its host-served dependencies missing on
  every single start; hermes-memory tried to mkdir into the frozen tree).

  Both derive their expected extension set from `pi-agent.registry.yaml`. A literal list here goes
  stale the moment the base set grows — `deploy-e2e` asserted `["power-tool", "task"]` through
  two releases of growth, red and unnoticed, because it was `PI_AGENT_E2E`-gated and the gate
  script ran only its sibling.
- **L2 — `scripts/run-sh-agent-e2e.sh`** (opt-in; spends tokens). One real model turn in **text
  mode** — NOT `--mode json`, which truncates output after the first tool call (pre-existing,
  source mode too). The agent must call a deployed tool; this is the tier that catches a tool
  schema the provider rejects (z.ai 400s any function schema whose root is not `type: "object"`).
- **L3 — `scripts/run-sh-agent-e2e.sh --tui`** (opt-in). The interactive TUI under a real pty
  (`script -q` + `stty`): banner lists extensions/skills, no sdk-patch warning.

## Skills and the `<inline:…>` label

Skills in an sh deploy ship **inside an extension** (`skills: true` in `pi-agent.registry.yaml`
copies the package's `skills/` dir into `ext/<name>/skills/`, and the core passes each to pi as a
`--skill` path), each with its OWNING extension: `btw` lives in ext-btw, `webui-audit` in
ext-webui (the #1724 re-homing — it had drifted into power-tool), `playwright-cli` stays with
power-tool (the playwright owner), and the superpowers / wayfind / hermes-memory / web-access /
hyperframes families ship from their own packages. `~/.pi/agent/skills/` remains empty by policy
(PR #1713).

`[Extensions] <inline:power-tool>` is also expected: the sh core hands pi extension *factories*
(no file path), and pi labels factory-registered extensions `<inline:…>`. It does not mean the
extension came from the repo's run-dir.

## The tree is read-only

`freeze: true` (the default) `chmod -R a-w`s the version dir once every gate has passed. `--ext`
unfreezes, rebuilds, re-runs the smoke gate and re-freezes; a re-deploy of the same version
unfreezes before removing. `--no-freeze` opts out — the e2e suites use it so their temp trees can
be cleaned up without an `EPERM`.

Freezing costs nothing at runtime because **no per-user state was ever written there**:

- pi's `getAgentDir()` reads `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. Sessions likewise.
- hermes-memory's sqlite DB reads the SAME `PI_CODING_AGENT_DIR`, else `~/.pi/agent` — and since
  Phase 1b a cwd it cannot write to holds no project store at all, so running the binary from
  inside its own tree no longer tries to create `.agents/` in it.
- The provider catalog is compiled into the core; model selection and API keys live in
  `~/.pi/agent` or the env (`docs/provider-model-config.md`).

`run.sh` beside the binary pins `PI_CODING_AGENT_DIR` anyway, so per-user state can never resolve
into the tree even if a caller's environment is unusual.

Two L1 assertions hold this: the tree gains no files while `doctor --smoke` runs, and none while a
REAL session starts with cwd set to the tree itself — the harshest placement, and the one that
found hermes-memory's mkdir.

## Limits

- **Base set (2026-08-20, "portable full-featured" profile): 14 extensions** — `task`,
  `prompt-history`, `superpowers`, `wayfind`, `hermes-memory`, `subagent`, `workflow`, `btw`,
  `web-access`, `power-tool`, `webui`, `hyperframes`, `obsidian`, `knowledge-card`. The earlier
  named blockers turned out to be stale on measurement: hermes-memory's sqlite is `bun:sqlite` (a
  builtin the host require serves), webui's HTML shell is a single inline string constant (no
  static assets), and the superpowers skills tree copies through the same path hyperframes
  already shipped.
- **Knowledge layer (obsidian + knowledge-card) joined the base set** (the #1733 dispatch move
  plus #1737's obsidian lib face made it possible; this change completes it): the
  isolated-process dispatch layer (`getSubagentRunPersistence` / `spawnSubagentSubprocess` +
  their record types) moved to `@repo/pi-agent-core-runtime`, so base-set extensions import it
  from the core-runtime host module instead of the subagent extension package (dep-guard forbids
  base-set ext→ext edges). knowledge-card consumes obsidian's lib face (#1737) instead of the
  extension entry — inlining the entry would double-register GATE_DEFS and duplicate its bulk.
  obsidian seeds a fresh vault on a portable machine from `vault-template/` (shipped via
  `copy:`, located through `require("#pi/ext-dir")`).
- **Excluded, with reasons**:
  `file2md` (mupdf native/wasm + a hard LM Studio localhost dependency — not portable), the
  director/MCP wrappers (`movie-director`, `flux2`, `krea2`, `ltx`, `zai-mcp`, `research-tool`,
  `archify` — bound to this machine's swift CLIs and services), and repo-internal tooling
  (`devops`, `tool-gate`). All stay available through the legacy source/run-dir modes.
- **Host modules**: `@earendil-works/pi-ai` (+`/compat`) — already compiled in via pi-coding-agent,
  served for identity stability; `@repo/pi-agent-core-interface` — GATE_DEFS is a shared mutable
  registry (obsidian, knowledge-card and wayfind all register gate families at module scope), so
  it must be ONE instance. `@repo/pi-agent-ext-subagent` was served for a while and is GONE
  as of HOST_API 2 — see "The host contract" above for why an extension must never be a host
  module. Adding a served module (as with core-interface) stays HOST_API 2: bundles built against
  2 simply never require it.
- **Locating bundled assets at runtime**: bun's cjs output folds `import.meta.url` into a
  build-machine path literal, REBINDS `__dirname`/`__filename` the same way, and an unfolded
  `import.meta` is a SyntaxError inside the loader's indirect cjs eval — so extensions resolve
  their deployed data (superpowers `skills/`, wayfind `procedures/`, hermes `scripts/`) through
  `require("#pi/ext-dir")`, served by the loader. In jiti/source mode the same specifier resolves
  via each package's `package.json` `"imports"` entry to `src/sh-ext-dir.ts` (real `__dirname`).
- **Vendored packages resolve by absolute file, not by specifier**: inside a compiled binary,
  `createRequire(<real path>)` and `Bun.resolveSync` cannot resolve *packages* from the real
  filesystem (module resolution is virtualized onto $bunfs) — the loader's fallback reads the
  vendored package.json (exports → require/default, then main) and requires the entry file
  directly. `unpdf` (web-access) is vendored for a second reason: its ESM uses
  `import.meta.resolve`, whose syntax cannot survive in a cjs bundle.
- No automatic cleanup of old version directories — `current` plus version dirs, nothing else.
- Same-machine assumption is unchanged from the legacy modes for the *build*; the deployed tree
  itself carries no repo paths.
