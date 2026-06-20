# `models/lora/ltx-2.3-restore/` — LTX-2.3 IC-LoRA restoration weights

Two IC-LoRA checkpoints used by **`run.py video restore`** (`app/commands/video-restore.py`)
to remove watermarks / subtitles / blur / compression artifacts from video via
LTX-2.3 IC-LoRA conditioning. Loaded raw as LoRA weights (no MLX conversion step) —
**drop-in raw weights**, no `manifest.json` needed.

## Required files

```
models/lora/ltx-2.3-restore/ltx2.3-video-restoration-general.safetensors
models/lora/ltx-2.3-restore/ltx2.3-ic-video-upscale-general.safetensors
```

Filenames **must** match exactly — `app/config.py` references them as
`LTX_RESTORE_LORA` / `LTX_UPSCALE_LORA`.

| File | Constant | Role |
|------|----------|------|
| `ltx2.3-video-restoration-general.safetensors` | `LTX_RESTORE_LORA` | Restoration (deartifact / deblur) conditioning |
| `ltx2.3-ic-video-upscale-general.safetensors` | `LTX_UPSCALE_LORA` | Upscale conditioning (skip with `--no-upscale-lora`) |

## Source

Download from Lightricks / CivitAI (search "LTX 2.3 IC-LoRA restoration" /
"IC video upscale"). Both are required for `video restore` unless overridden via
`--restoration-lora` / `--upscale-lora`.

## Why this lives here (not in `comfyui_data/`)

Previously defaulted to `comfyui_data/models/loras/…` — a gitignored ComfyUI
install artifact that vanishes on branch switch / `git clean`. The MLX runtime must
be self-contained (bun only spawns `run.py`), so user-downloaded LoRAs live in the
MLX-owned model tree. See `app/config.py` (`MODELS_DIR`).
