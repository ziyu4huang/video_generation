# PRD — s2-agent-ext-krea2

## Problem

The `krea2` Swift/MLX CLI (Krea 2 Turbo MMDiT) produces fast single-image drafts from text or image input. An agent needs a structured dispatcher for its two subcommands, with path validation, auto-binary-build, and stdout-regex result parsing — the same architecture as the larger flux2 extension, but simplified.

## Solution

A pi extension that wraps the `swift/krea2-image-director` CLI as one `krea2` dispatcher tool. Two subcommands (`t2i` and `i2i`), typed options, progress streaming, path-safety, and auto-binary-build. Pure Swift/MLX — zero Python on the default path.

## Tools

| Tool | Description |
|------|-------------|
| `krea2` | Single dispatcher tool with `t2i` (text→image) and `i2i` (image→image) subcommands |

## Key Dependencies

- `swift/krea2-image-director` (Swift/MLX binary, auto-built)
- `s2-agent` (run-dir manifest for auto-load)

## Use

```bash
bun bun-apps/s2-agent/src/cli.ts -e bun-apps/s2-agent-ext-krea2/extensions/krea2.ts -p "generate..."
```
