# Unified `deploy.ts` Design

**Goal:** Replace `build.ts` + `deploy.ts` + `build-extensions.ts` with a single
`deploy.ts` that offers four clearly named deploy modes.

**Status:** Design — awaiting user review.

## Architecture

```
scripts/
├── deploy.ts                          # NEW — unified orchestrator
├── lib/
│   ├── codegen.ts                     # NEW — pulled from build.ts codegen stages
│   ├── generate-embedded-assets.ts    # KEPT — unchanged from build.ts
│   └── build-extensions.ts            # MODIFIED — thin-bundle only, remove full
│
└── (removed)
    ├── build.ts                       # → deploy.ts
    └── deploy.ts (old)                # → deploy.ts
```

### What each file owns

| File | Responsibility |
|------|---------------|
| `deploy.ts` | Flag parsing, mode dispatch, stage orchestration, `run.sh` generation, read-only freeze |
| `lib/codegen.ts` | Write `src/generated/pi-pkg-dir.ts`, `run-dir-base.ts`, `embedded-assets.ts` |
| `lib/generate-embedded-assets.ts` | Walk asset dirs → `type: "file"` import manifest (unchanged) |
| `lib/build-extensions.ts` | Thin-bundle each ext in `manifest.json` → `ext-bundles/*.thin.js` |

## Interface

```bash
bun scripts/deploy.ts [target]            # --bundle (default)
bun scripts/deploy.ts [target] --bundle   # explicit: thin bundle, no node_modules
bun scripts/deploy.ts [target] --snapshot # full source copy + node_modules
bun scripts/deploy.ts [target] --standalone # bundle + bun binary + run.sh
bun scripts/deploy.ts [target] --exe      # single executable (embed all assets)

# Modifiers (apply to any mode)
bun scripts/deploy.ts [target] --no-freeze    # skip chmod -R a-w
bun scripts/deploy.ts [target] --sourcemap    # emit .js.map
```

### Target directory behavior

- **Default:** `../../dist/s2-agent` (same as current `build.ts` output dir)
- **Explicit:** Any path. Created if absent.

## Four Modes

### 1. `--bundle` (default)

**Purpose:** Production deploy. Self-contained `.js` + thin-bundled extensions.
Relocatable on the same machine (baked absolute paths for shared deps).

**Output:**
```
target/
├── s2-agent.js                # bundled s2-agent (minified)
├── s2-agent.js.map            # only with --sourcemap
├── ext-bundles/*.thin.js      # one per extension
├── skills/                    # skill directories
├── run.sh                     # bun run s2-agent.js "$@"
├── .deploy-bundle             # marker
├── .deploy-readonly           # marker (unless --no-freeze)
└── .deploy-portable           # NOT written (distinct from old --portable)
```

**Stages:**
```
1. codegen()               # pi-pkg-dir.ts, run-dir-base.ts, empty embedded-assets.ts
2. bundle()                # bun build src/cli.ts → s2-agent.js
3. bundleExtensions()      # thin-bundle each ext → ext-bundles/*.thin.js
4. copySkills()            # manifest.skills → target/skills/
5. writeRunSh()            # run.sh with bun s2-agent.js "$@"
6. freeze()                # chmod -R a-w (unless --no-freeze)
```

**No `node_modules/`** — s2-agent.js + thin bundles resolve deps via baked
absolute paths to the repo's `.bun` store. For a portable copy that works on
another machine, use `--snapshot` or `--standalone`.

---

### 2. `--snapshot`

**Purpose:** Full debug environment. Complete source tree + node_modules.
Modify code in the target and re-run — no rebuild needed.
Replaces old `--release` mode.

**Output:**
```
target/
├── s2-agent/                    # full source tree (with generated files)
├── node_modules/                # cp -R from repo bun-apps/node_modules
├── run.sh                       # bun s2-agent/src/cli.ts "$@"
```

**Stages:**
```
1. codegen()               # generated files needed by patches
2. copyWorkspace()         # cp -R bun-apps/s2-agent → target/s2-agent/
3. copyNodeModules()       # cp -R bun-apps/node_modules → target/node_modules/
4. writeRunSh()            # run.sh with bun s2-agent/src/cli.ts "$@"
5. freeze()                # chmod -R a-w (unless --no-freeze)
```

**No bundling** — runs as source mode (`bun src/cli.ts`). Every extension
loads via jiti. node_modules is the same live copy as the repo, so all
workspace deps resolve.

---

### 3. `--standalone`

**Purpose:** Ship s2-agent to a machine without Bun installed.
Copies local bun binary alongside the bundle.

**Output:**
```
target/
├── s2-agent.js                # bundled s2-agent (same as --bundle)
├── ext-bundles/*.thin.js      # same as --bundle
├── skills/                    # same as --bundle
├── bun                        # copied from $(which bun)
├── run.sh                     # ./bun run s2-agent.js "$@"
├── .deploy-bundle             # marker
```

**Stages:**
```
1. codegen()
2. bundle()
3. bundleExtensions()
4. copySkills()
5. copyLocalBun()          # cp $(which bun) target/bun
6. writeRunSh()            # run.sh with ./bun s2-agent.js "$@"
7. freeze()
```

---

### 4. `--exe`

**Purpose:** Single executable with all assets embedded.
Replaces `--compile-embed` in the old `build.ts`.

**Output:**
```
target/
└── s2-agent                # standalone executable (~74 MB)
```

**Stages:**
```
1. codegen()               # pi-pkg-dir.ts, run-dir-base.ts, embedded-assets.ts (with type:file imports)
2. compile()               # bun build --compile src/cli.ts → target/s2-agent
                           # (single-pass: preserves $bunfs paths)
```

Skips bundle, ext-bundle, skills, run.sh entirely.

---

## Common Infrastructure

### `codegen()` (in `lib/codegen.ts`)

Same logic as current `build.ts` stages 0, 0b, 0c:

| Generated file | Always? | Why |
|----------------|---------|-----|
| `pi-pkg-dir.ts` | Yes | set-package-dir patch (bundle + binary modes) |
| `run-dir-base.ts` | Yes (except --exe?) | bundle-mode path baking |
| `embedded-assets.ts` | Yes (empty or populated) | extract-embedded-assets patch (always imported) |

For `--exe`, `embedded-assets.ts` is populated with `type: "file"` imports.
For all other modes, it's an empty array.

### `freeze()` — read-only contract

Applies `chmod -R a-w` + writes `.deploy-readonly` marker.
Skipped with `--no-freeze`.

Bundled and snapshot modes are frozen by default. Standalone might want
special handling (bun binary needs +x). Exe is naturally immutable.

### `writeRunSh()` — shared helper

Accepts `{useBun: boolean}`:
- `useBun=false` → `bun s2-agent.js "$@"` (system bun)
- `useBun=true`  → `./bun s2-agent.js "$@"` (local bun binary)

### Error handling

- Assert workspace deps at the top (same as current `build.ts`).
- Die with clear message if `target` already exists (unless `FORCE=1`).
- Each stage logs `▶ stage name` on start, `  ✓ detail` on success,
  `  ✗ detail` on failure → exit(1).

## Cleanup: what goes away

| File | Replaced by |
|------|-------------|
| `scripts/build.ts` | `deploy.ts --exe` / `deploy.ts --bundle` for bundle-only |
| `scripts/deploy.ts` (old) | `deploy.ts` |
| `scripts/build-extensions.ts` | `lib/build-extensions.ts` (thin-only) |
| `scripts/verify-extensions.ts` | `bun test --e2e` or delete (unused) |

## CI mapping

| Current job | New command |
|-------------|-------------|
| `compile-verify` | `bun scripts/deploy.ts --exe` + doctor |
| `deploy-verify` | `bun scripts/deploy.ts ./out` + doctor |
| `release-verify` | `bun scripts/deploy.ts ./out --snapshot` + doctor |
| `standalone-verify` | (new) `bun scripts/deploy.ts ./out --standalone` + doctor |

## Out of scope (for this change)

- `scripts/run-ext-e2e.sh`, `scripts/run-image-agent-e2e.sh`, `scripts/run-self-improve-loop.sh`
  — these are standalone CI scripts, not part of the build/deploy pipeline.
- `bun run build:exe` shorthand in package.json — will be updated to point at
  `deploy.ts --exe` as a follow-up.
