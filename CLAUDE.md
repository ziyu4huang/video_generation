# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Video Generation — MLX on Apple Silicon

## Communication

- **Conversation language**: 繁體中文 (zh_TW) — use zh_TW for discussion, explanations, and Q&A
- **Written output**: English — all docs, code comments, commit messages, and file content in English

## Active stack

Image/video generation runs via **MLX on Apple Silicon**, surfaced through a **Bun + React GUI**:

- **MLX pipeline** — `python/mlx-movie-director/run.py` (Z-Image / Flux2 Klein / Lens / LTX-2.3 / SeedVR2, all native MLX). The only generation runtime.
- **Bun GUI** — `bun-apps/gui-movie-director` (`bun run dev`; port is per-worktree — discover with `bun run gui:port`). Spawns `run.py`; never touches ComfyUI.

## Python — Choose the Right Venv

```bash
# mlx-movie-director (image/video generation) — from repo root only
python/venv/bin/python python/mlx-movie-director/run.py <args>

# NEVER: python3 / python3.13 (system/uv-managed, no project deps)
# (ComfyUI/.venv is DEPRECATED — abandoned; do not use.)
```

> **Invoke from repo root only.** The mlx venv is at `python/venv/` (not inside `python/mlx-movie-director/`). Running `cd python/mlx-movie-director && python/venv/bin/python run.py` fails — the relative path breaks after `cd`. `run.py` resolves model paths from `__file__`, so cwd doesn't matter.

## Platform: Apple Silicon MPS

- **No CUDA attention**: SageAttention, Flash Attention, xformers need CUDA. SDPA only on MPS.
- **MLX dtypes**: `bfloat16` is native full-precision; quantize to `mlx-8bit` (default) or 4-bit. No FP8 path.

## Startup

```bash
cd bun-apps/gui-movie-director && bun run dev   # ACTIVE — GUI (port is per-worktree, see below)
bun run gui:port                           # this worktree's url (--all lists every server)
```

The GUI above is the only entry point (`./run.sh` was removed 2026-06-21).

## run.py Subcommands

All commands: `python/venv/bin/python python/mlx-movie-director/run.py <cmd>`.

```
image [subcommand]   default: t2i
  t2i, angle, review, profile, controlnet, i2i, faceswap, swap,
  anime2real, quality, workflow, expansion, purify, restore

video [subcommand]   default: generate
  generate, review, compare, quality, restore, vbvr, relay, segment, t2i2v

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

## Video T2I2V Pipeline (`video t2i2v`)

3-stage pipeline: ZImage T2I → VLM prompt assistant → LTX I2V. Omit `--action` to skip VLM stage. See [[t2i2v-pipeline]] memory for full args and examples.

## Lens T2I (`--pipeline lens`)

Microsoft Lens 3.8B — separate pipeline family, no LoRA/ControlNet. Defaults: 512×512, 20 steps, cfg=4.0. See [[project-lens-mlx]] memory for CLI details.

## Image Caption

`run.py caption <IMAGE> [--style <style>]` — local VLM analysis via Qwen3-VL 4B (LM Studio). **Prefer over MCP** — MCP cannot read local paths. See [[image-caption]] memory for all styles.

## Bun GUI Server

```bash
cd bun-apps/gui-movie-director && bun run dev    # hot reload (port is per-worktree)
bun run gui:port                            # this worktree's url; --all lists every server
```

**Do NOT use `bun run start`** — no file watching. Use `bun run dev:watch` only if hot reload breaks.

**Port is per-worktree** (concurrent dev): the primary worktree (real `.git`) uses **3099**;
each linked worktree derives a stable port from its path (`lib/worktree.ts`). Don't assume
3099 — run `bun run gui:port` for yours. Kill a stuck server by its discovered port
(`lsof -ti :<port> | xargs kill -9`).

## Testing

```bash
# Bun (from bun-apps/gui-movie-director/)
bun test
bun run check:schema    # validate all command schemas against run.py CLI

# Python (from repo root)
python/venv/bin/python -m pytest python/mlx-movie-director/app/tests
python/venv/bin/python -m pytest python/mlx-movie-director/app/tests --run-gpu    # real MLX + Metal
```

Browser automation: use `playwright-cli` skill. Before automating, capture a screenshot and run
`run.py caption <shot> --style playwright --lang en` — the text snapshot shows structure but not
current field values or selected state; the caption fills that gap.

## Model Import Commands

`import-checkpoint` (transformer) and `import-lora-image` (LoRA) download from CivitAI, quantize to mlx-8bit, and auto-symlink binaries to `../video_generation__models/<md5>.safetensors`. Never commit raw safetensors. CIVITAI_TOKEN always available. See [[model-import]] memory for full commands.

## Key Directories

```
python/mlx-movie-director/            # ACTIVE — MLX pipeline
python/mlx-movie-director/models/     # ACTIVE — MLX-owned model tree (runtime paths live here)
python/mlx-movie-director/models/store-manifest.json  # tracks all externalized model files
../video_generation__models/          # EXTERNAL binary store (outside repo, gitignored)
bun-apps/gui-movie-director/               # ACTIVE — Bun + React GUI
comfyui_data/models/                  # raw sources for convert.py (BUILD-TIME ONLY) — NOT a runtime dep
```

## Known Issues & Fixes

See [`.claude/memory/MEMORY.md`](.claude/memory/MEMORY.md) for lessons learned across sessions.

## Dynamic Workflow Self-Improve

See [[self-improve-sop]] memory for the full procedure. Key: branch off `main` (dev retired), clean tree required for `fix:true`, always use `{scriptPath}` not `{name}`, do NOT `--delete-branch` on PR merge.

## Vendor patches (active)

**Vendor patches** (ltx-2-mlx / mflux): live in `python/mlx-movie-director/app/vendor_patches.py`
as import-time monkey-patches. Never edit vendor submodules directly — `git submodule update` wipes
working-tree edits. Add new patches by appending a `_patch_*()` function and registering it in
`apply_all_patches()`.

