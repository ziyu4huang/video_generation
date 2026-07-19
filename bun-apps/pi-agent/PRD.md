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
- All `pi-agent-ext-*` workspace members (loaded via run-dir manifest)

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
  (and its `.hash` sidecars) on every run before rebuilding. See
  `docs/deploy-efficiency.md` for detail.
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

## Cross-reference

- [`PRD-e2e-testing.md`](./PRD-e2e-testing.md) — the e2e judgment test layer spec
- [`docs/pi-cross-machine-setup.md`](docs/pi-cross-machine-setup.md) — fresh-machine setup
- [`docs/extension-registry.PRD.md`](docs/extension-registry.PRD.md) — how extensions physically load (manifest, peerDeps, jiti/Bun resolution)
- [`docs/slash-commands-tools-skills.md`](docs/slash-commands-tools-skills.md) — how slash commands, tools, skills, and extensions relate at runtime
