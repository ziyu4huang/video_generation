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

**Found and verified 2026-07-05**: `joyfox/LTX2.3-ICEdit-Insight` on HuggingFace
(Apache-2.0, non-gated) contains both files by their exact required filenames:

```
https://huggingface.co/joyfox/LTX2.3-ICEdit-Insight/resolve/main/ltx2.3-video-restoration-general.safetensors
https://huggingface.co/joyfox/LTX2.3-ICEdit-Insight/resolve/main/ltx2.3-ic-video-upscale-general.safetensors
```

(The official `Lightricks/LTX-2.3-22b-IC-LoRA-Decompression` also exists but is
gate-flagged — needs a one-time HuggingFace license click before download.)

Both are required for `video restore` (Python) / `native-upscale --mode hd`
(Swift) unless overridden via `--restoration-lora`/`--upscale-lora` /
`--restoration-lora`/`--upscale-lora`. Download with `curl -L -o <name>.safetensors
<url>` (plain `curl -I` without `-L` misreports the size as a ~1 KB LFS
pointer — follow the redirect to see the real ~100/327 MB). Externalize
like every other LoRA in this repo (copy into `../video_generation__models/`,
replace with a relative symlink, update `mlx-models/store-manifest.json`) —
this directory's raw-weights convention (see `.raw-download`) only means
"skip the MLX-manifest pipeline," not "exempt from the never-commit-raw-
safetensors rule."

## Why this lives here (not in `comfyui_data/`)

Previously defaulted to `comfyui_data/models/loras/…` — a gitignored ComfyUI
install artifact that vanishes on branch switch / `git clean`. The MLX runtime must
be self-contained (bun only spawns `run.py`), so user-downloaded LoRAs live in the
MLX-owned model tree. See `app/config.py` (`MODELS_DIR`).
