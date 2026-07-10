# PRD — pi-agent-ext-flux2

## Problem

The `flux2` Swift/MLX CLI (Flux2 Klein 9B + SAM3.1) has 18 subcommands with complex flag combinations. An agent needs a structured, type-safe dispatcher that handles manifest parsing, path validation, and result chaining — not raw argv construction.

## Solution

A pi extension that wraps the `swift/flux2-image-director` CLI as one `flux2` dispatcher tool. Typed per-command options, structured manifest parsing, progress streaming, abort support, path-safety guards, and auto-binary-build. Supports multi-seed scene pipeline with VLM winner-picking.

## Tools

| Tool | Description |
|------|-------------|
| `flux2` | Single dispatcher tool with 18 subcommands: `t2i`, `scene`, `edit`, `style`, `kv-style-transfer`, `angle`, `swap`, `expand`, `upscale`, `gate`, `segment`, `story`, `models`, `verify-*` |

## Key Dependencies

- `swift/flux2-image-director` (Swift/MLX binary, auto-built)
- `pi-agent` (run-dir manifest for auto-load)
- `pi-agent-ext-vlm` (for scene pipeline VLM verification)

## Use

```bash
bun bun-apps/pi-agent/src/cli.ts -e bun-apps/pi-agent-ext-flux2/extensions/pi-flux2.ts -p "generate..."
```
