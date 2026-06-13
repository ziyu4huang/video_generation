# Video Generation — ComfyUI on Apple Silicon

Project-level instructions for Claude Code sessions working on this ComfyUI setup.

## Communication

- **Conversation language**: 繁體中文 (zh_TW) — use zh_TW for discussion, explanations, and Q&A
- **Written output**: English — all docs, code comments, commit messages, and file content in English

## Python — Choose the Right Venv

This repo has **two separate Python venvs** for different subsystems. Use the correct one.

### For mlx-movie-director (image/video generation scripts)

```bash
# Correct:
python/venv/bin/python python/mlx-movie-director/run.py image --prompt "..."
python/venv/bin/python python/mlx-movie-director/run.py image controlnet --self-test
python/venv/bin/python python/mlx-movie-director/convert.py --all

# Installed deps: mlx, torch, diffusers, transformers, safetensors, Pillow, etc.
```

- Venv at `python/venv/` — Python 3.13.13
- Requirements: `python/mlx-movie-director/requirements.txt`
- Used for all `run.py` subcommands: `t2i`, `image`, `refine`, `upscale`, `caption`, `replay`, `video`, `animate`, `controlnet`, `faceswap`, etc.

### For ComfyUI (workflow execution)

```bash
# Correct:
ComfyUI/.venv/bin/python script.py
ComfyUI/.venv/bin/python -c "import torch; ..."
```

- Venv at `ComfyUI/.venv/` — Python 3.13.13, same as `run.sh`
- Has all deps: torch, safetensors, websocket-client, requests, etc.

### Never use system Python

```bash
# WRONG — never use these:
python3 script.py          # system Python 3.9, lacks project deps
python3.13 script.py       # uv-managed, pip install fails (PEP 668)
```

## Platform: Apple Silicon MPS

All workflows run on **Apple Silicon (MPS backend)**. This constrains what works:

- **FP8 supported via patch**: `--supports-fp8-compute` is active in `run.sh`. The `fp8-mps-metal` custom node patches `comfy_kitchen.scaled_mm_v2` to route MPS+FP8 ops to Metal GPU kernels, fixing the original `ValueError: Invalid scaling configuration`. See `docs/fp8-mps-apple-silicon.md`.
- **No CUDA-only attention**: SageAttention, Flash Attention, xformers — all require CUDA. SDPA is the only option on MPS.
- **Triton is a stub**: `scripts/install_stubs.sh` creates a fake `triton` package so RMBG-SAM3 and torch._inductor load without errors. It does nothing at runtime.
- **FP8 model loading works**: `fp8-mps-metal` stores FP8 weights as uint8 on MPS (same bit pattern), handles quantize/dequantize via Metal GPU kernels.
- **Face DetailerForEach bypassed**: MPS VAE attention hits INT_MAX tensor dim limit on large face crops.

## Startup

```bash
./run.sh          # starts ComfyUI on http://127.0.0.1:8188
```

`run.sh` handles: venv bootstrap, platform stubs, git patches, MPS env vars (`PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0`, `PYTORCH_ENABLE_MPS_FALLBACK=1`).

## Workflows

| # | Name | File | Models |
|---|---|---|---|
| 1 | Anime → Real Style Transfer | `flux2-klein9b.json` | Flux 2 Klein 9B bf16 + anything2real LoRA |
| 2 | Multi-Pose Character Sheet | `anime2real.json` | Flux 2 Klein 9B bf16 |
| 3 | LTX-2.3 Video Generation | `ltx2.3-singularity.json` | LTX-2.3 22B bf16 + Singularity LoRA |
| 4 | Moody Zimage Photorealistic | `moody-zimage-v7.5.json` | Moody V12.6 DPO + SeedVR2 7B |

## Image Caption (replaces MCP image analysis)

Use `run.py caption` to analyze local images with a local VLM (Qwen3-VL 4B via LM Studio). **Prefer this over MCP-based image analysis tools** — MCP tools cannot read local file paths and will error.

```bash
# MUST use the project venv
cd python/mlx-movie-director
python/venv/bin/python run.py caption <IMAGE> [options]

# Describe image (default style)
python/venv/bin/python run.py caption output/base.png

# Photography analysis (subject, lighting, camera angle, composition)
python/venv/bin/python run.py caption base.png --style photography

# Generate a T2I prompt from an image
python/venv/bin/python run.py caption base.png --style prompt --lang en

# Quality scoring (1-10 on 6 dimensions)
python/venv/bin/python run.py caption base.png --style score --lang en

# Art style analysis
python/venv/bin/python run.py caption base.png --style style
```

| Flag | Default | Description |
|------|---------|-------------|
| `--style` | `default` | `default`, `photography`, `prompt`, `profile`, `style`, `score` |
| `--lang` | `zh_TW` | `zh_TW`, `zh_CN`, `en`, `ja` |
| `--model` | `qwen/qwen3-vl-4b` | OpenAI-compatible model name |
| `--api-url` | `http://localhost:1234/v1` | VLM API base URL |
| `--output` | `<image>.caption.json` | Output JSON path |

Output is a JSON file with `{image, style, model, caption}`. Requires LM Studio running locally.

## Bun GUI Server (Movie Director UI)

The web UI at `bun/gui-movie-director/` is a Bun + React SPA with live job management.

### Always run in dev hot mode

```bash
cd bun/gui-movie-director && bun run dev
```

`bun run dev` = `bun run --watch server.ts` which:
- Auto-restarts the **server** when backend files (`server.ts`, `api/*.ts`, `lib/*.ts`) change
- Watches `frontend/` directory and **rebuilds the bundle** on `.tsx`/`.ts`/`.css` changes
- Pushes `hmr-reload` via WebSocket → browser auto-refreshes

**Do NOT use `bun run start`** — that has no file watching or HMR. Always use `bun run dev`.

Server runs on **http://localhost:3099**. Kill existing instances with `lsof -ti :3099 | xargs kill`.

### Architecture

| Path | Role |
|------|------|
| `server.ts` | Entry — builds bundle, starts Bun.serve, starts file watcher |
| `api/routes.ts` | All HTTP routes + frontend bundle build logic |
| `api/ws.ts` | WebSocket handler (job logs, status, HMR reload) |
| `api/model-check.ts` | Model inventory scan + cache API |
| `frontend/app.tsx` | React SPA entry — COMMAND_GROUPS + VIEW_MAP |
| `frontend/views/` | View components (generate/, transform/, edit/, analyze/, tools/, gallery/, jobs/) |
| `frontend/styles.css` | Global CSS (dark theme, CSS variables) |
| `lib/config.ts` | Server config (pythonPath, modelsDir, outputDir) |

### Frontend conventions

- Views live in `frontend/views/<group>/FooView.tsx`
- Register in `app.tsx`: add to `COMMAND_GROUPS` array + `VIEW_MAP` record
- CSS classes use lowercase-hyphen (e.g. `.mc-badge`, `.cmd-form`)
- CSS variables: `--bg-surface`, `--accent`, `--success`, `--warning`, `--error`, etc.

## Key Directories

```
ComfyUI/                          # submodule (not fully committed)
comfyui_data/models/              # ~90GB models (gitignored)
comfyui_data/custom_nodes/        # cloned packages (gitignored except stubs)
comfyui_data/user/default/workflows/  # workflow JSONs (committed)
patches/comfyui/                  # git patches applied on startup
scripts/install_stubs.sh          # triton + decord stubs for macOS
```

## Known Issues & Fixes

See [`.claude/memory/MEMORY.md`](.claude/memory/MEMORY.md) for the full index of lessons learned across sessions (FP8, SeedVR2 MPS config, prompt tuning, etc.).

## Patches

Git patches in `patches/comfyui/` are auto-applied by `run.sh`:
- MPS fp8 safety in `comfy/model_management.py`
- MPS quantized module fix in `comfy/ops.py`

## Filename Tokens

ComfyUI built-in tokens for SaveImage `filename_prefix`: `%year%`, `%month%`, `%day%`, `%hour%`, `%minute%`, `%second%`, `%width%`, `%height%`. The `%date:...%` syntax is from the pysssss plugin and won't resolve without it.
