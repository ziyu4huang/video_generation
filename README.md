# video_generation

ComfyUI on Apple Silicon (MPS) — image generation with **Flux 2 Klein 9B** (FP8/bf16), photorealistic pipeline with **Moody Zimage**, and video generation with **LTX-2.3**.

## Quick start

```bash
./run.sh                    # start ComfyUI → http://127.0.0.1:8188
./run.sh --fix-nodes        # re-clone/patch missing custom nodes, then exit
./run.sh --skip-restore     # skip node restore check (faster startup)
./run.sh --port 8189        # pass-through args go directly to ComfyUI
```

## Project structure

```
video_generation/
├── run.sh                              # entry point
├── ComfyUI/                            # submodule (patches auto-applied)
├── comfyui_data/
│   ├── models/                         # ~90 GB, gitignored
│   ├── custom_nodes/                   # gitignored, auto-restored by reinstall.sh
│   ├── user/default/workflows/         # committed JSON workflows
│   └── output/                         # gitignored
├── patches/
│   ├── comfyui/*.patch                 # MPS fp8 safety + quantized module fix
│   └── custom_nodes/
│       ├── reinstall.sh                # clone 18 nodes at pinned commits
│       └── fp8-mps-metal-init.patch    # Metal GPU FP8 kernel
└── scripts/
    └── install_stubs.sh                # triton + decord stubs (unavailable on macOS)
```

## Workflows

| Workflow | File | Models |
|---|---|---|
| Character Sheet (bf16) | `flux2-klein9b-character-profile.json` | Klein 9B bf16 |
| Character Sheet (fp8) | `flux2-klein9b-character-profile-fp8.json` | Klein 9B fp8 |
| Image Expansion | `flux2-klein-image-expansion.json` | Klein 9B bf16 + SeedVR2 7B |
| Face/Head Swap | `flux2-klein-face-head-swap.json` | Klein 9B bf16 |
| Anime → Real | `anime2real.json` | Klein 9B bf16 + anything2real LoRA |
| LTX-2.3 Video | `ltx2.3-singularity.json` | LTX-2.3 22B bf16 + Singularity LoRA |
| Moody Zimage | `moody-zimage-v7.5.json` | Moody V12.6 DPO + SeedVR2 7B |

## Flux 2 Klein 9B — FP8 on Apple Silicon

FP8 models normally fail on MPS (`ValueError: Invalid scaling configuration`) because PyTorch MPS has no native Float8 support. This setup makes FP8 work via two components:

1. **`run.sh` flag**: `--supports-fp8-compute` tells ComfyUI to load the FP8 model (stores weights as `uint8` on MPS — same bit pattern, valid dtype)
2. **`fp8-mps-metal` custom node**: patches `comfy_kitchen.scaled_mm_v2` to route MPS+FP8 matrix multiply ops through Metal GPU kernels instead of the broken CUDA path

Result: `flux-2-klein-9b-fp8.safetensors` loads and runs correctly on M-series Macs. The bf16 variant works without any patches but is ~2× larger on disk (17 GB vs 9 GB).

## Custom node management

18 git-based nodes are pinned at specific commits in `patches/custom_nodes/reinstall.sh` and auto-cloned on startup. 6 nodes are Manager-installed (not auto-restorable):

| Auto-restored (reinstall.sh) | Manager-installed |
|---|---|
| ComfyUI_Comfyroll_CustomNodes | ComfyUI-Manager |
| ComfyUI_essentials | ComfyUI-Easy-Use |
| ComfyUI_LayerStyle | ComfyUI-KJNodes |
| comfyui_memory_cleanup | cg-use-everywhere |
| ComfyUI_RH_LLM_API | ComfyUI-RMBG |
| ComfyUI_UltimateSDUpscale | Comfyui-Resolution-Master |
| ComfyUI-AutoCropFaces | |
| ComfyUI-Custom-Scripts | |
| ComfyUI-GGUF | |
| ComfyUI-Impact-Pack / Subpack | |
| Comfyui-PainterFluxImageEdit | |
| ComfyUI-qwenmultiangle | |
| ComfyUI-ReservedVRAM | |
| ComfyUI-SeedVR2_VideoUpscaler | |
| ComfyUI-VideoHelperSuite | |
| fp8-mps-metal | |
| rgthree-comfy | |

## PyTorch / MPS environment

| Package | Version | Note |
|---|---|---|
| torch | 2.12.0 | macOS arm64, MPS backend |
| torchvision | 0.27.0 | paired with torch 2.12.0 |
| attention_mode | `sdpa` | only stable option on MPS |

**Do not install `sageattention` or `flash-attn`** — both require CUDA to build and have no MPS backend. The `⚠️ SeedVR2 optimizations` startup warning can be ignored.

**Do not install `mps-flash-attn`** — it forces torch downgrade to <2.12 (breaks torchvision 0.27.0), and SeedVR2 calls the official `flash_attn` API, not `mps_flash_attn`, so it remains `Flash Attention ❌` regardless.

## Apple Silicon compatibility notes

- **FP8**: works via `fp8-mps-metal` patch + `--supports-fp8-compute` (see above)
- **Triton / decord**: stubs installed by `scripts/install_stubs.sh`; real packages unavailable on macOS
- **Face DetailerForEach**: bypassed in all workflows — MPS VAE attention hits INT_MAX on large face crops
- **SeedVR2**: `cache_model=False`, `offload_device=none`, `attention_mode=sdpa`
- **PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0** + **PYTORCH_ENABLE_MPS_FALLBACK=1** set in `run.sh`

## Models reference

### Flux 2 Klein 9B

| File | Size |
|---|---|
| `diffusion_models/flux-2-klein-9b-bf16.safetensors` | 17 GB |
| `diffusion_models/flux-2-klein-9b-fp8.safetensors` | 9 GB |
| `text_encoders/qwen_3_8b_fp8mixed.safetensors` | 8.2 GB |
| `vae/flux2-vae.safetensors` | 320 MB |
| `loras/anything2real_v1_f2k.safetensors` | 100 MB |

### Moody Zimage

| File | Size |
|---|---|
| `diffusion_models/moody-porn-v12.6_00001_.safetensors` | 12.3 GB |
| `text_encoders/qwen_3_4b.safetensors` | 8.0 GB |
| `vae/ae.safetensors` | 335 MB |
| `loras/zit_sda_v1.safetensors` | 170 MB |
| `SEEDVR2/seedvr2_ema_7b_fp16.safetensors` | 16.5 GB |
| `SEEDVR2/ema_vae_fp16.safetensors` | 501 MB |
| `upscale_models/4xNomosWebPhoto_RealPLKSR.pth` | 30 MB |
| `upscale_models/1xSkinContrast-SuperUltraCompact.pth` | 181 KB |

### LTX-2.3 Video

| File | Size |
|---|---|
| `diffusion_models/ltx-2.3-22b-distilled-1.1_transformer_only_bf16.safetensors` | 39 GB |
| `text_encoders/gemma_3_12B_it_fp8_e4m3fn.safetensors` | 12 GB |
| `text_encoders/ltx-2.3_text_projection_bf16.safetensors` | 2.2 GB |
| `vae/LTX23_video_vae_bf16.safetensors` | 1.4 GB |
| `vae/LTX23_audio_vae_bf16.safetensors` | 340 MB |
| `latent_upscale_models/ltx-2.3-spatial-upscaler-x1.5-1.0.safetensors` | 1.0 GB |
| `loras/Singularity-LTX-2.3_OmniCine_V1.safetensors` | 2.5 GB |
