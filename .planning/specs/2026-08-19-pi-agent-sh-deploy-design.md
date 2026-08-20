# pi-agent-sh deploy — versioned minimal-core + dynamic extension packages

Date: 2026-08-19
Status: approved design (implementation not started)
Scope: a NEW deploy pipeline living beside the existing `deploy.ts` four modes. The
existing `--bundle` / `--snapshot` / `--standalone` / `--exe` modes and every script
that calls them (`package.json` deploy scripts, `update-pi.sh --rebuild`,
`verify-deploy-cli.ts`, the deploy test suites) are left untouched.

## Problem

Today's `--exe` deploy compiles 14 extensions statically into the binary
(`src/static-extensions.ts`). Consequences:

- The binary is monolithic: an extension change requires a full recompile.
- Extensions cannot be added, removed, or upgraded independently of the core.
- The other three modes are not self-contained — they rely on a `node_modules`
  symlink into the machine-global bun store, so they are same-machine only.

Goal: a **minimal core executable** that runs with zero extensions present, plus
**independently built extension packages** it discovers at runtime, all inside a
**versioned deploy directory**.

## Non-goals

- Migrating all 14 static extensions. MVP packages exactly two: `task` and
  `power-tool`.
- Cross-machine portability of extension bundles beyond what the host-injection
  contract already gives (the bundles carry no absolute paths, so they are
  in fact relocatable — but this is not verified by the MVP gates).
- Replacing or deleting the existing four deploy modes.

## Verified facts (measured, not assumed)

Probes run on bun 1.3.14, macOS arm64:

1. A `bun build --compile` binary CAN dynamically `import()` a JS module from
   disk at runtime (non-analyzable specifier), and runs fine when that path is
   absent.
2. A disk module that resolves its own dependency (absolute-path import) gets a
   **different module instance** than the one embedded in the binary
   (identity check returned `false`).
3. Host injection (module object passed through `globalThis` or an injected
   `require`) preserves **identical module instance** (identity check returned
   `true`).
4. `bun build --format=cjs --external <spec>` emits
   `// @bun @bun-cjs` followed by `(function(exports, require, module, __filename, __dirname){…})`
   — a wrapper whose `require` the host can supply.
5. `Bun.YAML.parse` exists — the config parser needs no new dependency.

Fact 2 is why extension bundles must NOT resolve `@earendil-works/*` from disk:
`pi-agent-ext-task` builds TUI overlays and keybindings against the host's
running pi-tui, and a second instance would break identity-sensitive behavior.

## Architecture

### Deploy layout

```
~/proj/dist/pi-agent-sh/
  current -> 0.1.0+g520acb9/          # flipped atomically, only after verification
  0.1.0+g520acb9/
    pi-agent            # bun build --compile of src/cli-sh.ts — zero extensions
    run.sh              # thin launcher: env hardening + exec ./pi-agent
    deploy.json         # provenance: config snapshot, git sha, bun version, timestamp
    ext/
      task/       ext.json  ext.cjs
      power-tool/ ext.json  ext.cjs  skills/{btw,playwright-cli}/
```

Version string: `<package.json version>+g<git short sha>`. Re-deploying the same
sha overwrites that directory (with `--force`); a new sha gets a new directory.

The executable locates its own tree via `dirname(process.execPath)`. No repo path
is baked in. If `ext/` is missing, empty, or entirely corrupt, the core still
boots — it simply loads no extensions.

### New components

| Path | Responsibility |
|---|---|
| `bun-apps/pi-agent/src/cli-sh.ts` | sh-mode entry. Does NOT import `static-extensions.ts`. Applies patches, calls the ext-loader, passes the result to pi's `main()` |
| `bun-apps/pi-agent/src/sh/host-modules.ts` | Host module registry + `hostRequire()`; exports `HOST_API = 1` |
| `bun-apps/pi-agent/src/sh/ext-loader.ts` | Discover → validate → load `ext/*`; returns `{ factories, skillPaths, skipped }` |
| `bun-apps/pi-agent/deploy-config.yaml` | Single source of truth for what gets deployed |
| `bun-apps/pi-agent-ext-devops/scripts/deploy-sh.ts` | Build orchestrator (core exe, ext bundles, version dir, verification, symlink, freeze) |
| `bun-apps/pi-agent-ext-devops/scripts/lib/sh-config.ts` | YAML parse + schema validation + defaults |
| `bun-apps/pi-agent-ext-devops/scripts/lib/sh-ext-build.ts` | One extension → `ext.cjs` + `ext.json` + skills |
| `bun-apps/pi-agent-ext-devops/scripts/lib/sh-version.ts` | Version string, target-dir resolution, `current` symlink swap |
| `bun-apps/pi-agent-ext-devops/src/deploy-sh-cli.ts` | CLI surface (JSON stdout, exit 0/1/2, `--help`), following the existing devops CLI convention |

`src/cli.ts` (the existing entry for all four legacy modes) is not modified.

## Host ↔ extension contract

### `ext.json`

Read before any code is executed, so a bad or incompatible extension is skipped
without evaluating it.

```json
{
  "name": "power-tool",
  "package": "@repo/pi-agent-ext-power-tool",
  "version": "0.1.0",
  "hostApi": 1,
  "entry": "ext.cjs",
  "order": 50,
  "enabled": true,
  "skills": ["skills"],
  "hostModules": ["@earendil-works/pi-coding-agent", "typebox"],
  "builtAt": "2026-08-19T20:13:00Z",
  "sourceSha": "520acb928"
}
```

Field rules:

- `name` — must equal the containing directory name; mismatch → skip + warn.
- `hostApi` — integer. Must equal the core's `HOST_API`; mismatch → skip + warn.
- `entry` — relative path inside the ext dir; must not escape it (`..` rejected).
- `order` — ascending load order; ties broken by `name`. `task` = 10,
  `power-tool` = 50.
- `enabled` — `false` → skip silently (it is a deliberate off switch).
- `skills` — relative dirs spliced into argv as `--skill <abs>`.
- `hostModules` — every entry must exist in the host registry; any miss → skip +
  warn (this is the version-drift tripwire: an ext built against a newer host
  refuses to half-load).
- `builtAt` / `sourceSha` — provenance only, never used for decisions.

### Loading rules — degrade, never crash

1. Scan `<exeDir>/ext/*/`. A directory without `ext.json` is ignored silently
   (it is not an extension).
2. Unparseable `ext.json`, failed validation, `enabled:false`, `hostApi`
   mismatch, missing host module, missing entry file → **skip that one
   extension, warn on stderr, continue with the rest**.
3. A throw during evaluation or during factory extraction → same treatment:
   skip + warn, never abort the boot.
4. Sort survivors by `(order, name)`, load, collect `default` exports as
   factories.
5. Pass factories via `main(argv, { extensionFactories })`; splice
   `--skill <abs>` for each declared skills dir.
6. `-ne` (no extensions) from the user suppresses the whole set, matching
   today's `cli.ts` semantics.

### Dependency injection

Extension bundles are built `--format=cjs --target=bun` with the host module
whitelist marked `--external`. The loader evaluates the emitted wrapper with a
`require` that serves the host's own already-embedded modules, so extension and
host share one instance of pi's runtime.

Whitelist (MVP):

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`
- `@repo/pi-agent-core-runtime` — holds cross-extension singletons
  (`SubagentInFlightRegistry`); inlining it per-extension would split the
  singleton.

Everything else — including other `@repo/*` siblings such as
`@repo/pi-agent-core-interface` and `@repo/pi-agent-ext-subagent` — is inlined
into the extension bundle.

The host registry is an explicit static map in `host-modules.ts` (static
`import * as ns` per entry) so the compiler embeds exactly these modules and
nothing resolves at runtime.

**Known risk:** the loader depends on the shape of bun's cjs output (fact 4).
Mitigation: the deploy runs a load-probe of every freshly built `ext.cjs`
through the real loader, so a bun-version shape change fails the deploy rather
than reaching a user. Fallback design if that ever happens: emit ESM and
generate per-host-module shim modules at build time that read from a
`globalThis` registry.

## `deploy-config.yaml`

```yaml
outRoot: ~/proj/dist/pi-agent-sh
version:
  from: package.json
  gitSha: true            # → 0.1.0+g520acb9
freeze: true              # chmod a-w over the deployed tree
current: true             # flip the `current` symlink after verification passes
hostApi: 1
hostModules:
  - "@earendil-works/pi-coding-agent"
  - "@earendil-works/pi-tui"
  - typebox
  - "@repo/pi-agent-core-runtime"
extensions:
  - name: task
    package: pi-agent-ext-task
    entry: extensions/task.ts
    order: 10
  - name: power-tool
    package: pi-agent-ext-power-tool
    entry: extensions/power-tool.ts
    order: 50
    skills: [skills]
```

Validation: unknown top-level keys and unknown extension keys are errors (typos
must not silently no-op); `outRoot` expands `~`; every `package` must exist under
`bun-apps/`; every `entry` must exist; `name` must be unique; `hostApi` must
match the core's compiled-in `HOST_API` (a mismatch means the config and the
core disagree — hard error, not a warning).

CLI flags override config values; the config never overrides an explicit flag.

## CLI surface

`bun bun-apps/pi-agent-ext-devops/src/deploy-sh-cli.ts [flags]` — pure JSON on
stdout, exit 0 (ok) / 1 (failure) / 2 (usage), `--help` supported, matching the
other devops CLIs.

| Flag | Meaning |
|---|---|
| *(none)* | Full deploy: core exe + all enabled extensions + verification + symlink |
| `--ext <name>` (repeatable) | Rebuild only these extensions into an existing version dir (unfreeze that subtree, rewrite, re-freeze, re-verify). Fails if the target version dir does not exist |
| `--list` | List deployed versions and which one `current` points at |
| `--config <path>` | Alternate config file (default `bun-apps/pi-agent/deploy-config.yaml`) |
| `--out <root>` | Override `outRoot` |
| `--version <str>` | Override the computed version string |
| `--no-freeze` / `--no-current` | Skip chmod / skip symlink flip |
| `--force` | Overwrite an existing version dir |

A `package.json` script in `bun-apps/pi-agent` (`deploy:sh`) points at the same
CLI so the ergonomics match the existing `deploy:*` scripts.

## Build pipeline

1. **Parse + validate** config; resolve version and target dir. Refuse a
   non-empty target without `--force`.
2. **Stage into a temp dir** (`<outRoot>/.staging-<version>`), never in place —
   a failed deploy must not leave a half-written version dir.
3. **Core**: `bun build --compile src/cli-sh.ts --outfile <stage>/pi-agent`.
4. **Extensions**, per entry: `bun build --format=cjs --target=bun --external <whitelist>`
   → `<stage>/ext/<name>/ext.cjs`; copy declared skills dirs; write `ext.json`.
5. **Verification** (all must pass, see below).
6. **Promote**: rename staging → `<outRoot>/<version>`, write `deploy.json`,
   apply freeze, flip `current`.

## Verification gates (run by the deploy, not by hand)

1. **Load probe** — every built `ext.cjs` is loaded through the real
   `ext-loader` with a mock host require; the default export must be a function.
2. **Bare-specifier scan** — leftover bare specifiers in each bundle must be a
   subset of the host whitelist. Reuses the existing
   `extractBareSpecifiers()` from `scripts/lib/build-extensions.ts`.
3. **Dual-state smoke test** — `<stage>/pi-agent --ext-list` (a new diagnostic
   flag in `cli-sh.ts` that prints discovered/loaded/skipped extensions as JSON
   and exits) must report both MVP extensions loaded; then `ext/` is moved aside
   and the same command must exit 0 reporting zero extensions. This is the
   executable proof of requirement (2).

Any gate failing aborts the deploy: staging is removed, `current` is untouched.

## Test plan

`bun-apps/pi-agent` (`bun test`, `bun run typecheck`):

- `sh/ext-loader.test.ts` — discovery; `(order, name)` sorting; dir without
  `ext.json` ignored; corrupt JSON skipped; `hostApi` mismatch skipped; missing
  host module skipped; `name`/dir mismatch skipped; entry escaping the ext dir
  rejected; throwing extension skipped without aborting; empty/missing `ext/`
  yields zero factories; `-ne` suppresses everything; skills paths returned as
  absolute.
- `sh/host-modules.test.ts` — registry contains exactly the whitelist;
  `hostRequire` on an unknown specifier throws a named error; `HOST_API` is the
  single source consumed by both loader and config validation.

`bun-apps/pi-agent-ext-devops` (`bun test`):

- `sh-config.test.ts` — valid config parses; unknown key rejected; `~` expansion;
  missing package/entry rejected; duplicate name rejected; flag-over-config
  precedence.
- `sh-version.test.ts` — version string composition; target resolution;
  non-empty target refusal; symlink swap is atomic and only happens after
  verification; `--list` output shape.
- `sh-ext-build.test.ts` — one extension builds to `ext.cjs` + `ext.json`;
  skills copied; bare-specifier scan catches an injected off-whitelist import;
  load probe rejects a bundle with no default export.
- e2e (behind the existing `PI_AGENT_E2E` gate, alongside `deploy-e2e.test.ts`):
  full deploy to a temp root, both smoke states, single-`--ext` rebuild path.

## Open item requiring manual confirmation

Host injection is measured to preserve module identity, and the automated gates
prove the extensions load and the core survives without them — but `task`'s
interactive behavior (TUI overlays, keybindings) can only be confirmed by
running the deployed TUI. After the first successful deploy, a manual check of
`/goal`, `todo`, and `ask_user_question` against `current/run.sh` is required
before the MVP is considered done.

## Follow-ups (deliberately out of MVP)

- Migrate the remaining 12 static extensions to ext packages (each needs its own
  assets/skills/native-dep review — `hermes-memory` sqlite, `webui` static
  assets, `superpowers` skills tree).
- Retention/GC of old version directories (the user chose plain `current` +
  version dirs for MVP; no automatic cleanup).
- Decide whether the legacy four modes get retired once this pipeline proves
  itself.

## Resolution — non-goals superseded (2026-08-20)

Superseded-by: `.planning/specs/2026-08-20-deploy-architecture-consolidation-design.md`

The non-goal "Replacing or deleting the existing four deploy modes" no longer holds.
It was the right call while this pipeline was unproven; the pipeline has since shipped
with four build gates plus an L1 e2e and is the only deploy artifact with a consumer.
The consolidation design deletes `scripts/deploy.ts`'s four modes, folds the three
legacy deploy docs into one, and collapses the three extension registries into the
config file this design introduced.

The rest of this document — the host-module contract, the loader design, the gate
family, the versioned layout — is unchanged and still current.
