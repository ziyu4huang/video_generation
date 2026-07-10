# PRD — pi-agent-cli

## Problem

Agent workflows like `vlm-describe`, `zk-extract`, `zk-ask`, and `pipeline pdf-to-vault` need a self-contained, non-interactive CLI entry point — one command per run, no TUI loop, no persistent session. Each run curates only the tools it needs instead of loading every extension.

## Solution

A self-contained CLI with extensions baked in as workspace deps. Drives pi-agent via the SDK from TypeScript on Bun. Ships agent workflows (vlm-describe, zk-extract, zk-ask, pipeline pdf-to-vault) plus a pi-compatible passthrough so the binary can serve as its own sub-agent target. Extensions are imported directly into the process (`pi-obsidian`, `pi-vlm`, `pi-knowledge-card` as `workspace:*` deps) without `.pi/settings.json` entries.

## Tools / Commands

| Command | Description |
|---------|-------------|
| `zk-extract` | Decompose files → Zettelkasten notes via subagent |
| `zk-ask` | Graph-enhanced RAG over Zettelkasten vault |
| `zk-ingest` | Deterministic convergence of structured records → vault cards |
| `vlm-describe` | PDF/image → Obsidian markdown via LM Studio VLM |
| `pipeline pdf-to-vault` | Multi-stage PDF pipeline |
| `doctor` | Self-check: runtime, repo layout, run-dir manifest, MLX paths, Obsidian vault |
| `workflow run` | Headless engine runner for pi-agent-ext-workflow scripts |
| `workflow list` | Enumerate available engine workflows |
| (passthrough) | Any pi-agent subcommand in non-interactive mode |

## Key Dependencies

- `@earendil-works/pi-coding-agent` (SDK)
- `pi-agent-ext-obsidian` (always loaded for vault access)
- `pi-agent-ext-vlm` (VLM describe)
- `pi-agent-ext-knowledge-card` (zk-extract, zk-ask, zk-ingest)
- `pi-agent-ext-power-tool` (doctor diagnostics)

## Use

```bash
bun bun-apps/pi-agent-cli/src/cli.ts <command> [options]
```

## Cross-reference

- [`docs/workflow-cli.md`](docs/workflow-cli.md) — headless engine runner reference
- [`../pi-agent/docs/pi-cross-machine-setup.md`](../pi-agent/docs/pi-cross-machine-setup.md) — fresh-machine steps
