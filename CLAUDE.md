# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- Used for all `run.py` subcommands — see **run.py Subcommands** below

> **Working directory & venv path.** The mlx venv lives at repo-root
> `python/venv/` — **not** inside `python/mlx-movie-director/`. So
> `cd python/mlx-movie-director && python/venv/bin/python run.py …` fails with
> `no such file or directory` (the relative venv path no longer resolves after
> the `cd`). `run.py` resolves `MODELS_DIR`/paths from its own `__file__`
> location (absolute), so it writes to the correct place from **any** cwd —
> **invoke from repo root**: `python/venv/bin/python python/mlx-movie-director/run.py <args>` (no `cd`).

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

## run.py Subcommands

All commands run via `python/venv/bin/python python/mlx-movie-director/run.py`.

```
image [subcommand]   default: t2i
  t2i, angle, review, profile, controlnet, i2i, faceswap, swap,
  anime2real, quality, workflow, expansion, purify, restore

video [subcommand]   default: generate
  generate, review, compare, quality, restore, vbvr, relay

caption <image>      VLM image analysis (see section below)
replay <manifest>    re-run a previous generation from JSON manifest
upscale              ESRGAN-only upscale
check-model          model manifest validation
schema               print full CLI schema as JSON
schema-defaults      print schema defaults for a given action
```

Microsoft Lens T2I is a `--pipeline lens` option of `image t2i` (alongside
`zimage` and `flux2-klein`) — see the **Lens T2I** section below.

Deprecated aliases still accepted: `generate` → `image`, `check-manifests` → `check-model`.
Removed top-level commands (`lens`, `t2i`) are auto-rewritten to their canonical
`image t2i` form with a deprecation nudge.

### Self-test flag

Most subcommands support `--self-test` to run a named reproducibility check without a live prompt:

```bash
python/venv/bin/python python/mlx-movie-director/run.py image t2i --self-test                     # default test
python/venv/bin/python python/mlx-movie-director/run.py image t2i --self-test t2i:portrait        # named test
python/venv/bin/python python/mlx-movie-director/run.py image i2i --self-test i2i:pose i2i:style  # multiple
```

Available test names per action are listed in `run.py schema-defaults` or via `bun run check:schema` in the GUI project.

## Lens T2I (Microsoft Lens 3.8B, pure MLX)

Independent text-to-image pipeline: Microsoft Lens 3.8B dual-stream MMDiT +
GPT-OSS-20B encoder + Flux2 VAE. It is a **separate model family** from
Z-Image/Flux (no LoRA, ControlNet, i2i, or shared args), so it is a
`--pipeline lens` option of `image t2i` (alongside `zimage` and `flux2-klein`),
not an `image` sub-action of its own.

```bash
python/venv/bin/python python/mlx-movie-director/run.py image t2i --pipeline lens --prompt 'a cute corgi puppy, photorealistic'
python/venv/bin/python python/mlx-movie-director/run.py image t2i --pipeline lens --self-test                       # built-in prompt + seed
python/venv/bin/python python/mlx-movie-director/run.py image t2i --pipeline lens --prompt '...' --width 1024 --height 1024  # higher res = better
```

| Flag | Default | Description |
|------|---------|-------------|
| `--pipeline lens` | — | Select the Lens model family |
| `--prompt` / `--prompt-file` | — | Text prompt (or use `--self-test`) |
| `--width` / `--height` | 512 / 512 | Must be divisible by 16 (Lens default differs from zimage's 640×960) |
| `--steps` | 20 | Official default 50 |
| `--cfg-scale` | 4.0 | Classifier-free guidance. Lens: default 4.0. zimage: opt-in (default None=off, single forward/step; `>1.0` enables CFG via dual cond/uncond forward — the biggest quality lever, cfg≈3.0 optimal; see `dark-beast-dbzit9/kb.jsonl`). flux2-klein: ignored (distilled, guidance=1.0). |
| `--seed` / `--count` | 777 / 1 | RNG seed / batch (default seed 777 as of 2026-06-18) |
| `--json-summary` | off | Machine-readable output for automation |

The flow-matching shift (`mu`) is computed dynamically via `compute_empirical_mu`
(resolution + step count), matching microsoft/Lens — no `--shift` flag is
exposed. Requires INT4 Lens models (~16 GB: TE 13 GB + UNet 2.6 GB + Flux2 VAE),
loaded lazily on first `generate()` (~5s). ~7s/20 steps at 512². Lens is a
high-resolution model (its gallery is all ≥1440²); 512² is out-of-distribution,
quality rises further at 1024² and with 50 steps.

Sampling matches the official [`microsoft/Lens`](https://github.com/microsoft/Lens)
pipeline: dynamic mu (`compute_empirical_mu`), CFG velocity norm-rescaling,
Flux2 VAE BatchNorm de-normalization. Full bug-fix history (8 bugs across two
rounds) in [docs/lens-mlx-t2i-rope-patchify.md](docs/lens-mlx-t2i-rope-patchify.md).

## Image Caption (replaces MCP image analysis)

Use `run.py caption` to analyze local images with a local VLM (Qwen3-VL 4B via LM Studio). **Prefer this over MCP-based image analysis tools** — MCP tools cannot read local file paths and will error.

```bash
# MUST use the project venv (from repo root — see "Working directory & venv path" above)
python/venv/bin/python python/mlx-movie-director/run.py caption <IMAGE> [options]

# Describe image (the 'default' style)
python/venv/bin/python python/mlx-movie-director/run.py caption output/base.png --style default

# Photography analysis (subject, lighting, camera angle, composition)
python/venv/bin/python python/mlx-movie-director/run.py caption base.png --style photography

# Generate a T2I prompt from an image
python/venv/bin/python python/mlx-movie-director/run.py caption base.png --style t2i --lang en

# Quality scoring (1-10 on 6 dimensions)
python/venv/bin/python python/mlx-movie-director/run.py caption base.png --style score --lang en

# Art style analysis
python/venv/bin/python python/mlx-movie-director/run.py caption base.png --style style

# GUI screenshot analysis (layout + interactive elements, for playwright-cli automation)
python/venv/bin/python python/mlx-movie-director/run.py caption screenshot.png --style playwright --lang en
```

| Flag | Default | Description |
|------|---------|-------------|
| `--style` | `t2i` | `default`, `photography`, `t2i`, `profile`, `style`, `score`, `compare`, `review`, `playwright` |
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

`bun run dev` = `bun --hot server.ts` which:
- **Backend HMR**: Bun swaps changed modules in-place — no process restart, WebSocket connections stay alive, jobs stay in memory
- **Frontend HMR**: Watches `frontend/` and **rebuilds the bundle** on `.tsx`/`.ts`/`.css` changes, then pushes `hmr-reload` via WebSocket → browser auto-refreshes
- `globalThis._devServer` / `_devInitialized` guard prevents double-init on hot reloads

**Do NOT use `bun run start`** — no file watching. Use `bun run dev:watch` only if hot reload breaks (`--watch` does a full restart).

Server runs on **http://localhost:3099**. Kill existing instances with `lsof -ti :3099 | xargs kill -9`.

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
- Register a `ViewDescriptor` in `frontend/views/index.ts` — `COMMAND_GROUPS` and `VIEW_MAP` in `app.tsx` are auto-derived from that array
- Views are mounted once on first navigation and toggled via CSS `display` (never unmounted)
- CSS classes use lowercase-hyphen (e.g. `.mc-badge`, `.cmd-form`)
- CSS variables: `--bg-surface`, `--accent`, `--success`, `--warning`, `--error`, etc.

## Testing

### Bun (from `bun/gui-movie-director/`)

```bash
bun test                           # all tests
bun test --coverage                # with coverage
bun test schemas/t2i.test.ts       # single file
bun run check:schema               # validate all command schemas against run.py CLI
```

Test files: `schemas/*.test.ts` (one per command), `lib/*.test.ts`, `api/gallery.test.ts`.

### Python mlx-movie-director

```bash
# From repo root — pytest discovers pytest.ini under python/mlx-movie-director/
python/venv/bin/python -m pytest python/mlx-movie-director/app/tests           # all tests (CPU-only, fast)
python/venv/bin/python -m pytest python/mlx-movie-director/app/tests/test_run_config.py -v  # single file

# Custom flags (defined in app/tests/conftest.py):
python/venv/bin/python -m pytest python/mlx-movie-director/app/tests --run-gpu         # real MLX weights + Metal GPU
python/venv/bin/python -m pytest python/mlx-movie-director/app/tests --run-slow        # tests >30s
python/venv/bin/python -m pytest python/mlx-movie-director/app/tests --update-baselines  # regenerate hash baselines

# With coverage:
python/venv/bin/python -m pytest python/mlx-movie-director/app/tests --cov=app --cov-report=html
```

Config: `python/mlx-movie-director/pytest.ini` — `testpaths = app/tests`, strict markers, short tracebacks.

### Browser automation with playwright-cli

The GUI at `http://localhost:3099` can be driven with the `playwright-cli` skill (`playwright-cli open`, `snapshot`, `click eNN`, `fill eNN "..."`). Element refs (`e15`) come from the text snapshot.

**Understand a page visually before automating.** The text YAML snapshot lists structure but not what's visible on screen. When you need to understand a screenshot — current field values, which dropdown option is selected, badges/counts, error messages, disabled controls — capture it and run the local VLM first:

```bash
playwright-cli screenshot --filename=/tmp/gui.png
python/venv/bin/python python/mlx-movie-director/run.py caption /tmp/gui.png --style playwright --lang en
# → structured report: LAYOUT, INTERACTIVE ELEMENTS (by visible label + current value),
#   STATE (selected values, badges, errors), PRIMARY ACTION (enabled/disabled)
```

Use the caption ALONGSIDE the text snapshot, not instead of it: the caption gives visible labels/current state to locate elements; the snapshot gives refs to click them. Requires LM Studio running locally (the caption auto-loads the model).

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

### Vendor patches (ltx-2-mlx / mflux) — runtime, NOT git patches

The `patches/comfyui/` mechanism above is **ComfyUI-only**. Fixes to the Python
vendor submodules (`vendor/ltx-2-mlx`, `vendor/mflux`) follow a different
convention: those submodules are kept **clean at upstream HEAD**, and all local
fixes live in `python/mlx-movie-director/app/vendor_patches.py` as import-time
monkey-patches (auto-applied via `apply_all_patches()` when `app.ltx_pipeline`
is imported).

**Never** leave working-tree edits in a vendor submodule or add git patches
under `patches/` for them — `git submodule update` would silently wipe working-
tree edits, and they'd stay permanently "dirty".

To add a vendor fix:
1. Append a `_patch_*()` function (model the style on `_patch_orchestration` —
   Patch 5 — which replaces a loader to insert a call).
2. Register it in `apply_all_patches()` and bump the count + the inventory
   docstring at the top of the file.

Current inventory: 8 ltx-2-mlx patches + 3 mflux patches. Notable:
- Patch 5 — inserts `apply_quantization` before `load_weights` (transformer).
- Patch 11 — same insert for the connector (`PromptEncoder.load` +
  `load_feature_extractor`); fixes INT8 connector loading.

## Filename Tokens

ComfyUI built-in tokens for SaveImage `filename_prefix`: `%year%`, `%month%`, `%day%`, `%hour%`, `%minute%`, `%second%`, `%width%`, `%height%`. The `%date:...%` syntax is from the pysssss plugin and won't resolve without it.
