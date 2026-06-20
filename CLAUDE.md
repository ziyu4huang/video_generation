# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Video Generation — MLX on Apple Silicon

> ## ⚠️ ComfyUI is DEPRECATED (abandoned 2026-06-21)
> The ComfyUI code path is **outdated and no longer maintained** — do NOT invest
> effort in it. This includes the `ComfyUI/` submodule, `patches/comfyui/`,
> `ComfyUI/.venv`, the removed `run.sh` (`:8188` server), and the ComfyUI workflow JSONs.
>
> The **active stack** is the **MLX pipeline** (`python/mlx-movie-director/run.py`)
> driven by the **Bun GUI** (`bun/gui-movie-director`). The Bun app only ever
> spawns `run.py` — it never invokes ComfyUI — and the MLX runtime was fully
> decoupled from `comfyui_data/` at runtime (commit `aab6150`). ComfyUI content is
> quarantined to the **"ComfyUI — DEPRECATED"** section at the bottom of this file
> (historical reference only). `comfyui_data/models/` survives solely as raw
> download sources for `convert.py` (build-time, not runtime).

## Communication

- **Conversation language**: 繁體中文 (zh_TW) — use zh_TW for discussion, explanations, and Q&A
- **Written output**: English — all docs, code comments, commit messages, and file content in English

## Active stack

Image/video generation runs via **MLX on Apple Silicon**, surfaced through a **Bun + React GUI**:

- **MLX pipeline** — `python/mlx-movie-director/run.py` (Z-Image / Flux2 Klein / Lens / LTX-2.3 / SeedVR2, all native MLX). The only generation runtime.
- **Bun GUI** — `bun/gui-movie-director` (`bun run dev` → http://localhost:3099). Spawns `run.py`; never touches ComfyUI.

## Python — Choose the Right Venv

```bash
# mlx-movie-director (image/video generation) — from repo root only
python/venv/bin/python python/mlx-movie-director/run.py <args>

# NEVER: python3 / python3.13 (system/uv-managed, no project deps)
# (ComfyUI/.venv is DEPRECATED — abandoned; do not use.)
```

> **Invoke from repo root only.** The mlx venv is at `python/venv/` (not inside `python/mlx-movie-director/`). Running `cd python/mlx-movie-director && python/venv/bin/python run.py` fails — the relative path breaks after `cd`. `run.py` resolves model paths from `__file__`, so cwd doesn't matter.

## Platform: Apple Silicon MPS

- **No CUDA attention**: SageAttention, Flash Attention, xformers need CUDA. SDPA only on MPS (mflux / LTX-2-mlx both use SDPA).

(The FP8 `--supports-fp8-compute` patch, the Triton/decord stub, and the
Face DetailerForEach bypass were ComfyUI-runtime concerns — see the deprecated
section. `scripts/install_stubs.sh` is part of that abandoned path.)

## Startup

```bash
cd bun/gui-movie-director && bun run dev   # ACTIVE — GUI on http://localhost:3099
lsof -ti :3099 | xargs kill -9             # kill if port stuck
```

`./run.sh` (the ComfyUI server on `:8188`) was **removed 2026-06-21** — it was pure ComfyUI;
the GUI above is the only entry point.

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
python/mlx-movie-director/            # ACTIVE — MLX pipeline
python/mlx-movie-director/models/     # ACTIVE — MLX-owned model tree (runtime paths live here)
bun/gui-movie-director/               # ACTIVE — Bun + React GUI
comfyui_data/models/                  # raw sources for convert.py (BUILD-TIME ONLY) — NOT a runtime dep
ComfyUI/                              # DEPRECATED submodule (abandoned)
comfyui_data/custom_nodes/            # DEPRECATED (ComfyUI clones, gitignored)
comfyui_data/user/default/workflows/  # DEPRECATED ComfyUI workflow JSONs
patches/comfyui/                      # DEPRECATED git patches (applied by the removed run.sh)
scripts/install_stubs.sh              # triton + decord stubs for the abandoned ComfyUI venv
```

## Known Issues & Fixes

See [`.claude/memory/MEMORY.md`](.claude/memory/MEMORY.md) for lessons learned across sessions.

## Vendor patches (active)

**Vendor patches** (ltx-2-mlx / mflux): live in `python/mlx-movie-director/app/vendor_patches.py`
as import-time monkey-patches. Never edit vendor submodules directly — `git submodule update` wipes
working-tree edits. Add new patches by appending a `_patch_*()` function and registering it in
`apply_all_patches()`.

---

# ComfyUI — DEPRECATED (abandoned 2026-06-21, historical reference only)

The content below documents the abandoned ComfyUI path. **Do not maintain or extend it.**
`run.sh` (removed 2026-06-21) was the ComfyUI entry point — it bootstrapped `ComfyUI/.venv`,
applied `patches/comfyui/`, patched `comfy_kitchen`, restored custom nodes, and launched ComfyUI
`main.py` on `:8188`. It never touched MLX or the Bun GUI.

## ComfyUI Workflows (DEPRECATED)

| # | Name | File | Models |
|---|---|---|---|
| 1 | Anime → Real Style Transfer | `flux2-klein9b.json` | Flux 2 Klein 9B bf16 + anything2real LoRA |
| 2 | Multi-Pose Character Sheet | `anime2real.json` | Flux 2 Klein 9B bf16 |
| 3 | LTX-2.3 Video Generation | `ltx2.3-singularity.json` | LTX-2.3 22B bf16 + Singularity LoRA |
| 4 | Moody Zimage Photorealistic | `moody-zimage-v7.5.json` | Moody V12.6 DPO + SeedVR2 7B |

## ComfyUI Patches (DEPRECATED)

Git patches in `patches/comfyui/` were auto-applied by `run.sh` (ComfyUI only; `run.sh` was removed 2026-06-21).
FP8 compute (`--supports-fp8-compute` + the `fp8-mps-metal` custom node patching `comfy_kitchen.scaled_mm_v2`
→ Metal kernels), the Triton/decord macOS stubs, and the Face DetailerForEach MPS INT_MAX bypass all
belonged to this path. See `docs/fp8-mps-apple-silicon.md`.

## ComfyUI Filename Tokens (DEPRECATED)

ComfyUI SaveImage `filename_prefix`: `%year%`, `%month%`, `%day%`, `%hour%`, `%minute%`, `%second%`,
`%width%`, `%height%`. (`%date:...%` needs pysssss plugin — won't resolve without it.)
