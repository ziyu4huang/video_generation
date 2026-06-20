# `models/vae/flux2-vae/` — Flux2 VAE (Lens T2I)

The Flux2 VAE in ComfyUI safetensors format, used by the **Lens T2I** pipeline
(`app/lens_pipeline.py`, `--pipeline lens`) for latent→pixel decode. Loaded raw via
`mx.load` (no MLX conversion step), so this is a **drop-in raw weight** — no
`manifest.json` / `config.json` needed (unlike the MLX-converted VAEs in sibling
dirs).

## Required file

```
models/vae/flux2-vae/flux2-vae.safetensors
```

The filename **must** be exactly `flux2-vae.safetensors` — `app/lens_pipeline.py`
references it as `cfg`-resolved `MODELS_DIR/vae/flux2-vae/flux2-vae.safetensors`
(constant `_LENS_VAE`).

## Source

Standard Flux2 VAE. Obtain the ComfyUI-format checkpoint
(`flux2-vae.safetensors`) and place it here. Override at runtime with
`--vae-path <path>` if you keep it elsewhere.

## Why this lives here (not in `comfyui_data/`)

The previous default pointed at `comfyui_data/models/vae/flux2-vae.safetensors`.
That dir is a gitignored ComfyUI install artifact and vanishes on branch switch /
`git clean`, breaking Lens T2I. The MLX runtime must be self-contained — the bun
app only ever spawns `run.py`, never ComfyUI — so the VAE lives in the MLX-owned
model tree. See `app/config.py` (`MODELS_DIR`).
