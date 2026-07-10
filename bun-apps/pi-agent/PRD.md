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
| **Fixed extension set** | `run-dir/manifest.json` — loads obsidian, vlm, flux2, krea2, ltx, movie-director, hermes, knowledge-card, research-tool, power-tool, subagents, web-access, workflow, zai-mcp |
| **Bundle support** | `bun scripts/build.ts` → single output `dist/pi-agent.js` |
| **E2E testing** | L2 (judgment) + L3 (real-model) workflow suites via `scripts/run-ext-e2e.sh` |

## Key Dependencies

- `@earendil-works/pi-coding-agent` (official pi runtime)
- All `pi-agent-ext-*` workspace members (loaded via run-dir manifest)

## Use

```bash
bun bun-apps/pi-agent/src/cli.ts   # source mode
# or
bun dist/pi-agent/pi-agent.js      # bundled mode
```

## Cross-reference

- [`PRD-e2e-testing.md`](./PRD-e2e-testing.md) — the e2e judgment test layer spec
- [`docs/pi-cross-machine-setup.md`](docs/pi-cross-machine-setup.md) — fresh-machine setup
