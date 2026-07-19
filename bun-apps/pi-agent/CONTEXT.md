# pi-agent

The ubiquitous language of pi-agent — a thin wrapper around the real pi TUI that layers reversible monkey-patches to add hardcoded providers and a cwd-independent extension set. It does not reimplement pi; it calls the official `main()` untouched.

## Language

### Wrapper model

**Thin wrapper**:
pi-agent calls the official `main()` from `@earendil-works/pi-coding-agent` untouched, then layers reversible monkey-patches — it never forks or reimplements pi.
_Avoid_: fork, reimplementation, port (it is a passthrough that patches in place)

**Patch** (`src/patches/<name>.ts`):
A reversible monkey-patch on a pi prototype/module (e.g. `ModelRuntime.create`), applied before `main()` runs. Bun's shared module cache means one patch affects every instance `main()` constructs.
_Avoid_: override, hook, plugin (it is a prototype monkey-patch, not a subclass or lifecycle hook)

**pre-load-providers** (`src/pre-load-providers.ts` + `src/patches/pre-load-providers-patch.ts`):
The hardcoded provider catalog (lm-studio, ollama, openrouter, …), injected by wrapping `ModelRuntime.create()` — no `~/.pi/agent/models.json` is read. Split across two files: `src/pre-load-providers.ts` holds the pure catalog (`PROVIDERS`) + `resolveApiKey`/`registerAllProviders` helpers, with no import-time side effects — safe for any consumer (e.g. `pi-agent-cli`) to import directly. The actual `ModelRuntime.create` wrap lives in `src/patches/pre-load-providers-patch.ts`, reached only through the env-gated `applyPatches()`. (Pre-0.80 SDK this hooked `ModelRegistry.prototype.loadModels`; that method was removed when ModelRegistry became a stateless facade over ModelRuntime, silently breaking the old patch — every runtime now goes through `ModelRuntime.create()`.)
_Avoid_: provider config, model list (it is source-hardcoded, not config-file-driven); don't reintroduce the patch into `pre-load-providers.ts` itself — that was the exact bug this split fixed (importing the catalog alone used to silently apply the patch)

### Resource loading

**run-dir** (`run-dir/`):
This repo's fixed extension + skill set, loaded cwd-independently by splicing resolved absolute paths into argv before `main()`. Never reads or writes anything under `<cwd>/.pi/`.
_Avoid_: config dir, settings (it is a cwd-independent resource manifest, not user config)

**manifest.json** (`run-dir/manifest.json`):
The **eager** extension/skill list — loaded every session. Edit this to add/remove workspace-local extensions.
_Avoid_: extension list (too generic; distinguish from the lazy registry)

**Lazy extension** (`run-dir/settings.json` `lazyExtensions`):
An opt-in extension resolved only when invoked via `-e <alias>` (e.g. `workflow`). Costs zero context unless asked for by alias — for heavy on-demand tools.
_Avoid_: optional extension, plugin (it is alias-gated, zero-cost-until-invoked)

**Alias resolution**:
`run-dir/resolve.ts` rewrites `-e <alias>` to an absolute factory path before `main()` sees argv. First-hit-wins: exact key → unique substring → single-`.ts` directory fallback; real paths and URL schemes pass through untouched.
_Avoid_: alias mapping, shortcut

**npmExtensions**:
The single array in `manifest.json` that is the source of truth for npm-sourced extensions, read by both `resolve.ts` (source) and `scripts/lib/codegen.ts` (bundle).
_Avoid_: deps list, package array

### Build & deploy

**Source / bundle / binary modes**:
The three execution modes. Source (`bun src/cli.ts`) resolves deps via the real node_modules; bundle (`dist/pi-agent/pi-agent.js`) symlinks a node_modules for `getAliases()`; the compiled binary (`--exe`) cannot dynamically load `.ts` extensions (jiti + Bun-compile `ENAMETOOLONG`) — it statically imports a fixed 5-extension set instead. `deploy.ts` also has `--snapshot` (raw source copy) and `--standalone` (bundle + bun binary), both still "source" or "bundle" at the `detectMode()` level.
_Avoid_: dev/prod modes (these are packaging modes, not environments)

**THIN bundle**:
The (only, since the unified `deploy.ts`) extension-bundling mode: each extension is pre-bundled to one `.js` sharing a single typebox instance instead of each pulling its own copy. Deployed as `ext-bundles/*.thin.js`.
_Avoid_: minified bundle, slim bundle, FULL bundle (a FULL/per-extension-typebox mode existed historically but was removed — see `docs/superpowers/plans/2026-07-18-unified-deploy.md`)

**Read-only deploy**:
The default deploy artifact — immutable (chmod a-w + `.deploy-readonly` marker), with all per-user state routed to `~/.pi/agent`. Drops onto `/opt` or an app bundle as-is.
_Avoid_: frozen release, static deploy (it is an immutable artifact with writable state routed out)

**Warm-deploy hash cache**:
Per-extension `<name>.<thin|full>.hash` sidecar (hashed over source tree + flag + externals + `Bun.version`) that lets a warm deploy skip rebuild for unchanged extensions.
_Avoid_: build cache, incremental cache

### Self-check

**doctor**:
The offline self-check — detects deploy mode, verifies the extension set is complete for it, checks host deps, reports provider keys + which patches would apply. Exit 0 = all hard checks pass.
_Avoid_: health check, preflight (it is a deploy/machine boundary-condition checker)

**`doctor --smoke`**:
Spawns a throwaway probe that calls `pi.getAllTools()` at `session_start` and counts run-dir-sourced tools — catches the silent-no-op class (extensions that fail to load while every static check stays green).
_Avoid_: runtime test, integration check (it is an offline tool-count probe at session_start)

**`doctor --fix`**:
Derives a fix plan from the report, applies it (e.g. `bun install` for a broken `--snapshot`/`--standalone` node_modules), then re-checks.
_Avoid_: auto-repair, remediation
