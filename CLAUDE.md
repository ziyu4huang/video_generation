# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Video Generation — ComfyUI on Apple Silicon

## Communication

- **Conversation language**: 繁體中文 (zh_TW) — use zh_TW for discussion, explanations, and Q&A
- **Written output**: English — all docs, code comments, commit messages, and file content in English

## Python — Choose the Right Venv

Two separate venvs — always use the right one.

```bash
# mlx-movie-director (image/video generation) — from repo root only
python/venv/bin/python python/mlx-movie-director/run.py <args>

# ComfyUI (workflow execution)
ComfyUI/.venv/bin/python <script>

# NEVER: python3 / python3.13 (system/uv-managed, no project deps)
```

> **Invoke from repo root only.** The mlx venv is at `python/venv/` (not inside `python/mlx-movie-director/`). Running `cd python/mlx-movie-director && python/venv/bin/python run.py` fails — the relative path breaks after `cd`. `run.py` resolves model paths from `__file__`, so cwd doesn't matter.

## Platform: Apple Silicon MPS

- **FP8 via patch**: `--supports-fp8-compute` in `run.sh`; `fp8-mps-metal` patches `comfy_kitchen.scaled_mm_v2` → Metal kernels. See `docs/fp8-mps-apple-silicon.md`.
- **No CUDA attention**: SageAttention, Flash Attention, xformers need CUDA. SDPA only on MPS.
- **Triton is a stub**: `scripts/install_stubs.sh` creates a fake package — does nothing at runtime.
- **Face DetailerForEach bypassed**: MPS VAE attention hits INT_MAX on large face crops.

## Startup

```bash
./run.sh          # ComfyUI on http://127.0.0.1:8188
```

## Workflows

| # | Name | File | Models |
|---|---|---|---|
| 1 | Anime → Real Style Transfer | `flux2-klein9b.json` | Flux 2 Klein 9B bf16 + anything2real LoRA |
| 2 | Multi-Pose Character Sheet | `anime2real.json` | Flux 2 Klein 9B bf16 |
| 3 | LTX-2.3 Video Generation | `ltx2.3-singularity.json` | LTX-2.3 22B bf16 + Singularity LoRA |
| 4 | Moody Zimage Photorealistic | `moody-zimage-v7.5.json` | Moody V12.6 DPO + SeedVR2 7B |

## run.py Subcommands

All commands: `python/venv/bin/python python/mlx-movie-director/run.py <cmd>`.

```
image [subcommand]   default: t2i
  t2i, angle, review, profile, controlnet, i2i, faceswap, swap,
  anime2real, quality, workflow, expansion, purify, restore

video [subcommand]   default: generate
  generate, review, compare, quality, restore, vbvr, relay

caption <image>      VLM image analysis (see below)
replay <manifest>    re-run from JSON manifest
upscale              ESRGAN-only upscale
check-model          model manifest validation
schema               print full CLI schema as JSON
schema-defaults      print defaults for a given action
```

Deprecated aliases: `generate` → `image`, `check-manifests` → `check-model`.

### Self-test flag

```bash
python/venv/bin/python python/mlx-movie-director/run.py image t2i --self-test
python/venv/bin/python python/mlx-movie-director/run.py image t2i --self-test t2i:portrait
python/venv/bin/python python/mlx-movie-director/run.py image i2i --self-test i2i:pose i2i:style
```

## Lens T2I (`--pipeline lens`)

Microsoft Lens 3.8B — separate model family from Z-Image/Flux (no LoRA, ControlNet, or shared args).

```bash
python/venv/bin/python python/mlx-movie-director/run.py image t2i --pipeline lens --prompt '...'
python/venv/bin/python python/mlx-movie-director/run.py image t2i --pipeline lens --self-test
```

Defaults: `--width 512 --height 512 --steps 20 --cfg-scale 4.0 --seed 777`. Higher res (1024²) + 50 steps → better quality. Requires ~16 GB INT4 models. Full implementation notes: `docs/lens-mlx-t2i-rope-patchify.md`.

## Image Caption

Use `run.py caption` for local images via Qwen3-VL 4B (LM Studio). **Prefer over MCP tools** — MCP cannot read local paths.

```bash
python/venv/bin/python python/mlx-movie-director/run.py caption <IMAGE> [--style <style>] [--lang en]
```

Styles: `default`, `photography`, `t2i`, `profile`, `style`, `score`, `compare`, `review`, `playwright`.
Output: `<image>.caption.json`. Requires LM Studio running locally.

## Bun GUI Server

```bash
cd bun/gui-movie-director && bun run dev    # hot reload on http://localhost:3099
lsof -ti :3099 | xargs kill -9             # kill if port stuck
```

**Do NOT use `bun run start`** — no file watching. Use `bun run dev:watch` only if hot reload breaks.

## Testing

```bash
# Bun (from bun/gui-movie-director/)
bun test
bun run check:schema    # validate all command schemas against run.py CLI

# Python (from repo root)
python/venv/bin/python -m pytest python/mlx-movie-director/app/tests
python/venv/bin/python -m pytest python/mlx-movie-director/app/tests --run-gpu    # real MLX + Metal
```

Browser automation: use `playwright-cli` skill. Before automating, capture a screenshot and run
`run.py caption <shot> --style playwright --lang en` — the text snapshot shows structure but not
current field values or selected state; the caption fills that gap.

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

See [`.claude/memory/MEMORY.md`](.claude/memory/MEMORY.md) for lessons learned across sessions.

## Patches

Git patches in `patches/comfyui/` are auto-applied by `run.sh` (ComfyUI only).

**Vendor patches** (ltx-2-mlx / mflux): live in `python/mlx-movie-director/app/vendor_patches.py`
as import-time monkey-patches. Never edit vendor submodules directly — `git submodule update` wipes
working-tree edits. Add new patches by appending a `_patch_*()` function and registering it in
`apply_all_patches()`.

## Filename Tokens

ComfyUI SaveImage `filename_prefix`: `%year%`, `%month%`, `%day%`, `%hour%`, `%minute%`, `%second%`,
`%width%`, `%height%`. (`%date:...%` needs pysssss plugin — won't resolve without it.)
