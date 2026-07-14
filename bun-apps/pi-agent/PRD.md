# PRD — pi-agent

## Problem

Users want to run the full pi-agent TUI with additional LLM providers (lm-studio, ollama, openrouter) and a fixed set of project-specific extensions, without external config files or per-session extension loading. The official `pi` package has no mechanism for shipping hardcoded provider configs inside the source.

## Solution

A thin wrapper around the official `@earendil-works/pi-coding-agent` TUI. It calls `main()` untouched, then applies reversible monkey-patches to `ModelRegistry.prototype.loadModels()` so extra providers are registered before the first session starts. The repo's fixed extension set (pi-obsidian, pi-vlm, zai-mcp, etc.) is baked in via `run-dir/manifest.json`, independent of invocation `cwd`.

## Capabilities

| Feature | Detail |
|---------|--------|
| **TUI passthrough** | Full pi TUI, all flags, sessions, tools |
| **Extra providers** | lm-studio, ollama, openrouter, llamacpp — hardcoded in `src/pre-load-providers.ts` |
| **Fixed extension set** | `run-dir/manifest.json` — loads obsidian, vlm, flux2, krea2, ltx, movie-director, hermes, knowledge-card, research-tool, power-tool, web-access, workflow, zai-mcp |
| **Bundle support** | `bun scripts/build.ts` → single output `dist/pi-agent.js` |
| **Deploy (3 modes)** | `deploy.ts` (bundle/THIN) · `--release` (source-copy) · `--portable` (FULL-bundle, repo-independent) |
| **Deploy `--verify`** | Boots deployed artifact from `/tmp`, probes `getAllTools()`: 43 tools, 0 conflicts, all 8 canary tools present |
| **E2E testing** | L2 (judgment) + L3 (real-model) + deploy e2e (4 modes × `--verify` + doctor + smoke + skill-load + readonly) |

## Key Dependencies

- `@earendil-works/pi-coding-agent` (official pi runtime)
- All `pi-agent-ext-*` workspace members (loaded via run-dir manifest)

## Deploy

Three self-contained deploy modes, all verified by e2e with `--verify`:

```bash
bun scripts/deploy.ts                  # bundle (THIN) → dist/pi-agent-bundle/
bun scripts/deploy.ts --release         # source-copy  → dist/pi-agent-deploy/
bun scripts/deploy.ts --portable        # FULL-bundle  → dist/pi-agent-portable/
bun scripts/deploy.ts --verify          # + boot probe (getAllTools from /tmp)
```

### Deploy verification layers

| Layer | What it checks | Where |
|-------|----------------|-------|
| **`--verify`** (deploy-time) | Boot from `/tmp`, `getAllTools()`: count, dupes, canary tools | `deploy.ts` |
| **Runtime probe** (e2e) | `session_start` probe: tool load, command load, zero errors | `e2e-extensions.test.ts` |
| **doctor** (e2e) | Mode detection + static checks (ext-bundles, host-deps, providers) | `doctor --json` |
| **doctor --smoke** (e2e) | Runtime spawn: run-dir extensions actually loaded (matched > 0) | `doctor --smoke --json` |
| **skill-load** (e2e) | `before_agent_start`: PwF SKILL.md in `systemPromptOptions.skills` | `e2e-extensions.test.ts` |
| **readonly** (e2e) | Frozen tree (chmod a-w): zero writes, foreign-cwd run, state routing | `e2e-readonly.test.ts` |

### Verification pipeline

```
                      deploy.ts --verify
                 boot from /tmp → getAllTools()
            43 tools · 0 conflicts · 8 canary tools present
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
  DEPLOY-BUNDLE         DEPLOY-PACKAGE       DEPLOY-PORTABLE
  (THIN ext-bundles)    (--release source)   (--portable FULL)
         │                    │                    │
         ▼                    ▼                    ▼
  ┌──────────────────────────────────────────────────────────┐
  │ e2e-extensions.test.ts (per mode):                       │
  │  · runtime probe  (session_start: tools + commands)      │
  │  · doctor --json  (mode + static checks)                 │
  │  · doctor --smoke (runtime spawn: matched > 0)           │
  │  · skill-load     (before_agent_start: PwF SKILL.md)     │
  ├──────────────────────────────────────────────────────────┤
  │ e2e-readonly.test.ts (bundle + release):                 │
  │  · frozen tree (chmod a-w) zero writes                   │
  │  · foreign-cwd run via run.sh                            │
  │  · state routing to PI_CODING_AGENT_DIR                  │
  └──────────────────────────────────────────────────────────┘
```

### Reproducibility

- **build-extensions hash cache**: sha256 over source tree + thin/full flag + `Bun.version` → cold build skipped on warm re-run
- **dep pinning**: `--release`/`--portable` pin floating `"latest"`/`"*"` to `bun.lock` resolved versions
- **read-only freeze**: every deploy is `chmod a-w` + `.deploy-readonly` marker by default; `run.sh` applies `JITI_FS_CACHE=0` + `PI_CODING_AGENT_DIR` routing

### Latest verified result

Verified at `origin/main` (`e0cdf8b4`, 2026-07-11):

| Tier | Tests | Result | Time |
|------|-------|--------|------|
| unit + patches | 189 pass, 2 skip | ✅ 0 fail | 19s |
| e2e-extensions (4 modes × `--verify`) | 22 pass | ✅ 0 fail | 149s |
| e2e-readonly (frozen bundle + release × `--verify`) | 10 pass | ✅ 0 fail | 75s |
| deploy `--verify` standalone | 43 tools, 0 conflicts, 8 canaries | ✅ | ~5s |
| **Total** | **221 pass, 2 skip** | ✅ **0 fail** | ~248s |

Run via:
```bash
bash bun-apps/pi-agent/run-test.sh high      # unit + patches + deploy e2e
bash bun-apps/pi-agent/run-test.sh readonly   # frozen-deploy contract
```

## Use

```bash
bun bun-apps/pi-agent/src/cli.ts   # source mode
# or
bun dist/pi-agent/pi-agent.js      # bundled mode
# or
bash dist/pi-agent-bundle/run.sh   # deployed mode (any cwd)
```

## Cross-reference

- [`PRD-e2e-testing.md`](./PRD-e2e-testing.md) — the e2e judgment test layer spec
- [`docs/pi-cross-machine-setup.md`](docs/pi-cross-machine-setup.md) — fresh-machine setup
