# `models/upscale/` — ESRGAN / Real-PLKSR upscale models

Single-image super-resolution models used by the **ESRGAN upscaler**
(`ZImagePipeline.upscale_esrgan`, reached from `run.py upscale`, `image upscale`,
and the `--upscale` post-step on image/video pipelines). Loaded raw via the
ESRGAN architecture (no MLX conversion step) — **drop-in raw weights**, no
`manifest.json` needed.

## Directory structure

```
models/upscale/
├── README.md                                  ← this file
└── 4x-nomos-webphoto-realplksr/               ← default upscale model
    └── 4xNomosWebPhoto_RealPLKSR.pth
```

Each sub-directory is one model instance containing the `.pth` weight file. The
default instance is resolved by `app.config.DEFAULT_UPSCALE_MODEL` (re-exported from
`app.commands._shared` / `app.commands._output`).

## Adding a new upscale model

1. Create `models/upscale/<instance-name>/`
2. Drop the `.pth` weight file inside
3. Point at it via `--upscale-model <path>` (or `--model` for `run.py upscale`)

## Why this lives here (not in `comfyui_data/`)

Previously defaulted to `comfyui_data/models/upscale_models/…` — a gitignored
ComfyUI install artifact that vanishes on branch switch / `git clean`. The MLX
runtime must be self-contained (bun only spawns `run.py`), so upscale weights live
in the MLX-owned model tree. See `app/config.py` (`MODELS_DIR`).
