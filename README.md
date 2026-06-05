# video_generation

ComfyUI setup for running **Flux 2 Klein 9B** image generation on Apple Silicon (MPS).

## Folder structure

```
video_generation/
├── run.sh                                        # start ComfyUI (run from here)
├── ComfyUI/                                      # ComfyUI source (not fully committed)
│   ├── comfy/model_management.py                 # patched: MPS fp8 safety
│   ├── comfy/ops.py                              # patched: MPS quantized module
│   └── run.sh                                    # wrapper → delegates to root run.sh
├── comfyui_data/                                 # all runtime data (gitignored except stubs/workflow)
│   ├── models/                                   # model files — NOT committed (too large)
│   │   ├── diffusion_models/flux-2-klein-9b-bf16.safetensors
│   │   ├── text_encoders/qwen_3_8b_fp8mixed.safetensors
│   │   └── vae/flux2-vae.safetensors
│   ├── custom_nodes/                             # cloned packages — NOT committed
│   │   └── flux2_klein_stubs.py                  # committed: VRAMReserver + MarkdownNote stubs
│   ├── user/default/workflows/
│   │   └── flux2-klein9b.json                    # committed: Klein 9B workflow
│   └── output/                                   # generated images — NOT committed
├── docs/
│   └── comfyui-flux2-klein9b-apple-silicon.md    # full setup guide
└── scripts/                                      # utility scripts
```

## Quick start

```bash
./run.sh
# open http://127.0.0.1:8188
```

## What's excluded from git

| Path | Reason |
|---|---|
| `ComfyUI/.venv/` | Python venv (2 GB) — rebuild with `pip install -r requirements.txt` |
| `comfyui_data/models/` | Model files (34 GB) — see docs for download instructions |
| `comfyui_data/output/` | Generated images |
| `comfyui_data/custom_nodes/ComfyUI-*/` | Cloned packages — reinstall via ComfyUI Manager |
| `**/__pycache__/` | Python bytecode cache |

## Required models

| File | Size | Source |
|---|---|---|
| `models/diffusion_models/flux-2-klein-9b-bf16.safetensors` | 17 GB | Converted from fp8 (see docs) |
| `models/text_encoders/qwen_3_8b_fp8mixed.safetensors` | 8.2 GB | Comfy-Org/flux2-klein-9B on HuggingFace |
| `models/vae/flux2-vae.safetensors` | 320 MB | Comfy-Org/flux2-dev on HuggingFace |

## Apple Silicon note

The original fp8 model (`flux-2-klein-9b-fp8.safetensors`) **does not work on MPS** — PyTorch MPS backend has no Float8 support. You must pre-convert it to bf16. See `docs/comfyui-flux2-klein9b-apple-silicon.md` Step 4 for the conversion script.

## Performance

~158 seconds per batch (4 images, 864×2016) on Apple Silicon MPS.
