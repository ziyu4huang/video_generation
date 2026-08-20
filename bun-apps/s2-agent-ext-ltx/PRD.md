# PRD — s2-agent-ext-ltx

## Problem

The `ltx-video` Swift/MLX CLI (LTX-2.3) provides image-to-video generation, audio, upscaling, and more across 15+ subcommands. Agents need a structured dispatcher with typed per-command options, stdout-regex result parsing (ltx-video has no manifest sidecar), progress streaming, abort support, and path-safety guards.

## Solution

A pi extension that wraps the `swift/ltx-video-director` CLI as one `ltx` dispatcher tool. Covers the native Swift path (native-i2v, native-upscale, native-t2a, native-relay, native-ingredients, native-restyle, segment, models, audio-decode, video-decode) and the production bridge path (i2v, upscale, gate, verify). Supports camera/lighting vocabulary injection via `shotLanguage`.

## Tools

| Tool | Description |
|------|-------------|
| `ltx` | Single dispatcher tool with 15+ subcommands for LTX-2.3 video, audio, upscaling, and verification |

## Key Dependencies

- `swift/ltx-video-director` (Swift/MLX binary, auto-built)
- `run.py` (production i2v bridge)
- `s2-agent` (run-dir manifest for auto-load)
- `s2-agent-ext-file2md` (verify subcommand)

## Use

```bash
bun bun-apps/s2-agent/src/cli.ts -e bun-apps/s2-agent-ext-ltx/extensions/ltx.ts -p "generate video..."
```
