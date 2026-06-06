# video_generation

ComfyUI setup for running **Flux 2 Klein 9B** image generation, **Moody Zimage** photorealistic pipeline, and **LTX-2.3** video generation on Apple Silicon (MPS).

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
│   │   ├── diffusion_models/
│   │   │   ├── flux-2-klein-9b-bf16.safetensors        # Klein 9B UNET (image)
│   │   │   └── ltx-2.3-22b-distilled-1.1...bf16.safetensors  # LTX-2.3 UNET (video)
│   │   ├── text_encoders/
│   │   │   ├── qwen_3_8b_fp8mixed.safetensors          # Klein CLIP
│   │   │   ├── gemma_3_12B_it_fp8_e4m3fn.safetensors   # LTX-2.3 CLIP 1
│   │   │   └── ltx-2.3_text_projection_bf16.safetensors # LTX-2.3 CLIP 2
│   │   ├── vae/
│   │   │   ├── flux2-vae.safetensors                    # Klein VAE
│   │   │   ├── LTX23_video_vae_bf16.safetensors         # LTX-2.3 video VAE
│   │   │   └── LTX23_audio_vae_bf16.safetensors         # LTX-2.3 audio VAE
│   │   ├── loras/
│   │   │   ├── anything2real_v1_f2k.safetensors
│   │   │   ├── klein_9B_Turbo_r128.safetensors
│   │   │   └── Singularity-LTX-2.3_OmniCine_V1.safetensors  # LTX-2.3 video LoRA
│   │   └── latent_upscale_models/
│   │       └── ltx-2.3-spatial-upscaler-x1.5-1.0.safetensors
│   ├── custom_nodes/                             # third-party repos — NOT committed, auto-restored
│   │   ├── VERSIONS.txt                          # committed: pinned commit manifest
│   │   ├── ltx-missing-node-stubs/               # committed: our stub nodes
│   │   └── ... (see Custom Node Management below)
│   ├── user/default/workflows/
│   │   ├── flux2-klein9b-character-profile.json  # committed: character sheet (bf16)
│   │   ├── flux2-klein9b-character-profile-fp8.json  # committed: character sheet (fp8)
│   │   ├── flux2-klein-face-head-swap.json       # committed: face/head swap
│   │   ├── flux2-klein-image-expansion.json      # committed: image expansion
│   │   ├── anime2real.json                       # committed: anime → real style transfer
│   │   ├── ltx2.3-singularity.json               # committed: LTX-2.3 video generation
│   │   └── moody-zimage-v7.5.json                # committed: Moody Zimage photorealistic
│   └── output/                                   # generated images — NOT committed
├── docs/
│   ├── fp8-mps-apple-silicon.md                  # FP8 Metal GPU kernel details
│   ├── flux2-klein-face-head-swap.md             # face swap pipeline guide
│   └── flux2-klein9b-bf16-vs-fp8.md              # model format comparison
├── patches/
│   ├── comfyui/                                  # patches applied to ComfyUI submodule
│   │   ├── model_management.patch                # MPS fp8 safety
│   │   └── ops.patch                             # MPS quantized module fix
│   └── custom_nodes/                             # custom node management
│       ├── reinstall.sh                          # auto-restore missing nodes
│       └── fp8-mps-metal-init.patch              # our Metal GPU FP8 kernel
└── scripts/
    ├── install_stubs.sh                          # triton/decord stubs for macOS
    └── comfy_bench.py                            # benchmark tool
```

## Quick start

```bash
./run.sh
# open http://127.0.0.1:8188
```

## Workflows

Both workflows share the same base models: `flux-2-klein-9b-bf16` + `qwen_3_8b` + `flux2-vae`.

### 1. Anime → Real Style Transfer (`flux2-klein9b.json`)

Converts anime/illustration-style images into realistic photographs using the `anything2real` LoRA.

| Setting | Value |
|---|---|
| LoRA | `anything2real_v1_f2k.safetensors` (strength 1.0) |
| Turbo LoRA | `klein_9B_Turbo_r128.safetensors` (bypassed by default) |
| Sampler | euler, 4 steps, CFG 1 |
| Positive prompt | "Preserve the subject's features and generate a high quality realistic human photograph" |

**Flow**: Upload anime image → scale to 2 MP (lanczos) → VAE encode → ReferenceLatent conditioning → sample → VAE decode → side-by-side comparison (original + output)

**Required custom nodes**: ComfyUI-Easy-Use (`easy imageConcat`)

### 2. Multi-Pose Character Sheet (`anime2real.json`)

Generates front / back / side A-pose views of a character from a single input image, then stitches them into one composite reference sheet.

| Setting | Value |
|---|---|
| LoRA | None (base model only) |
| Sampler | er_sde, 4 steps, CFG 1 |
| Resolution | 864×2016 (9:21 Ultra Portrait) via ResolutionMaster |
| Negative conditioning | ConditioningZeroOut |

**Prompts** (Chinese, composited via StringConcatenate):
- Front: "生成图中人物A-pose的正面图, 人物站立，去除杂物，白色背景，完美的身体比例，头不要太大，保持人物服装一致性"
- Back: "生成图中人物A-pose的背面图, ..."
- Side: "生成图中人物A-pose的侧面图, ..."

**Flow**: Upload image → scale → VAE encode → 3× parallel sampling (front/back/side with ReferenceLatent) → VAE decode → individual saves + AILab_ImageStitch composite

**Required custom nodes**:
- ComfyUI-RMBG (`AILab_ImageStitch`)
- Comfyui-Resolution-Master (`ResolutionMaster`)
- comfyui-kjnodes (`INTConstant`, `StringConstant`)

### 3. LTX-2.3 Video Generation (`ltx2.3-singularity.json`)

Image-to-video / first-last-frame-to-video generation using Lightricks LTX-2.3 (22B distilled) with the Singularity OmniCine LoRA. Supports audio generation via LTX-2.3's audio VAE.

| Setting | Value |
|---|---|
| UNET | `ltx-2.3-22b-distilled-1.1_transformer_only_bf16.safetensors` (39 GB, bf16 for MPS) |
| CLIP | `gemma_3_12B_it_fp8_e4m3fn` + `ltx-2.3_text_projection_bf16` (DualCLIPLoader) |
| VAE | `LTX23_video_vae_bf16` (video) + `LTX23_audio_vae_bf16` (audio) |
| LoRA | `Singularity-LTX-2.3_OmniCine_V1.safetensors` |
| Upscaler | `ltx-2.3-spatial-upscaler-x1.5-1.0` (latent space) |
| Sampler | euler_ancestral_cfg_pp + euler_cfg_pp, manual sigmas |
| Resolution | Scaled to max 1280px longer edge, divisible by 10 |

**Flow**: Upload image → resize to max 1280px → LTXVPreprocess → encode to latent → sample (two-pass with upscale) → VAE decode video + audio → VHS_VideoCombine

**Apple Silicon notes**:
- Uses bf16 UNET (fp8 doesn't work on MPS)
- SageAttention disabled (CUDA-only) — already set in the workflow
- 22B model requires ~40GB VRAM/RAM; 128GB unified memory recommended

**Required custom nodes**:
- ComfyUI-KJNodes (`VAELoaderKJ`, `LTXVImgToVideoInplaceKJ`, `PathchSageAttentionKJ`, `SimpleMath+`)
- ComfyUI-Easy-Use (`easy imageSize`, `easy int`, `easy mathInt`)
- ComfyUI_LayerStyle (`LayerUtility: ImageScaleByAspectRatio V2`)
- ComfyUI-VideoHelperSuite (`VHS_VideoCombine`)
- rgthree-comfy (`Fast Groups Muter`)
- ComfyUI-Custom-Scripts (`ShowText|pysssss`)
- ComfyUI_Comfyroll_CustomNodes (`CR Text`)
- Dapao-Toolbox (`Dapao_LlamaChat`) — optional, for LLM prompt generation
- ComfyUI_RH_LLM_API (`RH_LLMAPI_Pro_Node`) — optional, for LLM prompt generation

### 4. Moody Zimage Photorealistic Pipeline (`moody-zimage-v7.5.json`)

End-to-end photorealistic image generation using Moody Pro Mix (ZIT V12 DPO), a distilled FLUX-based model fine-tuned for high-quality output. Includes multi-stage upscaling and SeedVR2 super-resolution.

**Pipeline**: Generate image (ZIT 9-step) → UltimateSDUpscale (2.5×) → Skin contrast enhancement → ImageBlend → SeedVR2 super-resolution → Save

| Setting | Value |
|---|---|
| UNET | `moody-porn-v12.6_00001_` (ZIT V12 DPO, 11B) |
| CLIP | `qwen_3_4b` |
| VAE | `ae.safetensors` (FLUX VAE) |
| LoRA | `zit_sda_v1` (Z-Image SDA) |
| Sampler | dpmpp_2m_sde, 9 steps, CFG 3.5 |
| Upscale | UltimateSDUpscale 2.5× (768px tiles) + 4xNomosWebPhoto |
| Enhancement | 1× Skin Contrast → ImageBlend (0.3 blend) |
| Super-resolution | SeedVR2 7B (fp16) |
| Output | ~3K resolution, 12–15 MB PNG |

**Runtime estimation** (Apple Silicon MPS, 128GB unified memory):

| Stage | Time | % of Total |
|---|---|---|
| Model loading (UNET + CLIP + VAE + LoRA) | ~20s | 5% |
| CLIP text encoding | ~2s | <1% |
| 2× KSamplerAdvanced (9 steps) | ~30s | 8% |
| VAEDecode | ~3s | <1% |
| UltimateSDUpscale (2.5×, 768px tiles) | ~60–80s | 18% |
| ImageUpscaleWithModel + ImageBlend | ~3s | <1% |
| **SeedVR2VideoUpscaler (7B, ~3K output)** | **~240–280s** | **68%** |
| SaveImage ×2 | ~2s | <1% |
| **Total** | **~360–420s (~6–7 min)** | |

**Bottleneck**: SeedVR2 dominates at 68% of runtime. See Performance section for optimization options.

**Apple Silicon notes**:
- Face DetailerForEach nodes **bypassed** — MPS VAE attention fails on large face crops (INT_MAX tensor dim limit)
- `attention_mode=sdpa` (sageattn unavailable on MPS)
- `cache_model=False`, `offload_device=none` for SeedVR2
- Output filenames use `%year%-%month%-%day%` tokens (ComfyUI built-in), not `%date:...%` (requires pysssss plugin)

**Required custom nodes**:
- `ComfyUI-SeedVR2_VideoUpscaler` — SeedVR2 DiT/VAE loading and upscaling
- `ComfyUI_UltimateSDUpscale` — tiled SD upscaling
- `ComfyUI-Impact-Pack` — DetailerForEach (installed but bypassed on MPS)
- `ComfyUI-Impact-Subpack` — UltralyticsDetectorProvider (for face detection)
- `ComfyUI-GGUF` — GGUF model loading support
- `rgthree-comfy` — Seed node, Image Comparer
- `ComfyUI-KJNodes` — SimpleMath+, PrimitiveInt/Boolean

## What's excluded from git

| Path | Reason |
|---|---|
| `ComfyUI/.venv/` | Python venv (2 GB) — rebuild with `pip install -r requirements.txt` |
| `comfyui_data/models/` | Model files (~90 GB total) — see Required models below |
| `comfyui_data/output/` | Generated images / videos |
| `comfyui_data/custom_nodes/ComfyUI-*/` | Cloned packages — reinstall via ComfyUI Manager |
| `**/__pycache__/` | Python bytecode cache |

## Required models

### Moody Zimage (photorealistic generation + upscaling)

| File | Size | Description | Source |
|---|---|---|---|
| `models/diffusion_models/moody-porn-v12.6_00001_.safetensors` | 12.3 GB | Moody Pro Mix V12.6 DPO (ZIT V12) | CivitAI (manual download) |
| `models/text_encoders/qwen_3_4b.safetensors` | 8.0 GB | Qwen 3 4B text encoder | HuggingFace |
| `models/vae/ae.safetensors` | 335 MB | FLUX VAE (symlink to flux2-vae.safetensors) | Already have |
| `models/loras/zit_sda_v1.safetensors` | 170 MB | Z-Image Turbo SDA V1 LoRA | [F16/z-image-turbo-sda](https://huggingface.co/F16/z-image-turbo-sda) |
| `models/SEEDVR2/seedvr2_ema_7b_fp16.safetensors` | 16.5 GB | SeedVR2 7B DiT super-resolution | HuggingFace |
| `models/SEEDVR2/ema_vae_fp16.safetensors` | 501 MB | SeedVR2 VAE | HuggingFace |
| `models/upscale_models/4xNomosWebPhoto_RealPLKSR.pth` | 30 MB | 4× photo upscaler | [GitHub](https://github.com/TNTwise/REALPLKSR) |
| `models/upscale_models/1xSkinContrast-SuperUltraCompact.pth` | 181 KB | 1× skin contrast enhancement | HuggingFace |

### Flux 2 Klein 9B (image generation)

| File | Size | Source |
|---|---|---|
| `models/diffusion_models/flux-2-klein-9b-bf16.safetensors` | 17 GB | Converted from fp8 (see docs) |
| `models/text_encoders/qwen_3_8b_fp8mixed.safetensors` | 8.2 GB | Comfy-Org/flux2-klein-9B on HuggingFace |
| `models/vae/flux2-vae.safetensors` | 320 MB | Comfy-Org/flux2-dev on HuggingFace |
| `models/loras/anything2real_v1_f2k.safetensors` | 100 MB | Flux2-Klein community LoRA |
| `models/loras/klein_9B_Turbo_r128.safetensors` | 100 MB | Flux2-Klein Turbo acceleration (optional) |

### LTX-2.3 (video generation)

| File | Size | Source |
|---|---|---|
| `models/diffusion_models/ltx-2.3-22b-distilled-1.1_transformer_only_bf16.safetensors` | 39 GB | [Kijai/LTX2.3_comfy](https://huggingface.co/Kijai/LTX2.3_comfy) |
| `models/text_encoders/gemma_3_12B_it_fp8_e4m3fn.safetensors` | 12 GB | [GitMylo/LTX-2-comfy_gemma_fp8_e4m3fn](https://huggingface.co/GitMylo/LTX-2-comfy_gemma_fp8_e4m3fn) |
| `models/text_encoders/ltx-2.3_text_projection_bf16.safetensors` | 2.2 GB | [Kijai/LTX2.3_comfy](https://huggingface.co/Kijai/LTX2.3_comfy) |
| `models/vae/LTX23_video_vae_bf16.safetensors` | 1.4 GB | [Kijai/LTX2.3_comfy](https://huggingface.co/Kijai/LTX2.3_comfy) |
| `models/vae/LTX23_audio_vae_bf16.safetensors` | 340 MB | [Kijai/LTX2.3_comfy](https://huggingface.co/Kijai/LTX2.3_comfy) |
| `models/latent_upscale_models/ltx-2.3-spatial-upscaler-x1.5-1.0.safetensors` | 1.0 GB | [Lightricks/LTX-2.3](https://huggingface.co/Lightricks/LTX-2.3) |
| `models/loras/Singularity-LTX-2.3_OmniCine_V1.safetensors` | 2.5 GB | Community LoRA |

## Apple Silicon note

The original fp8 model (`flux-2-klein-9b-fp8.safetensors`) **does not work on MPS** — PyTorch MPS backend has no Float8 support. You must pre-convert it to bf16. See `docs/comfyui-flux2-klein9b-apple-silicon.md` Step 4 for the conversion script.

## macOS / Apple Silicon compatibility fixes

### Database path (`run.sh`)

`--database-url` is passed explicitly so the SQLite file lands in `comfyui_data/user/` (matching `--base-directory`) instead of the hardcoded `ComfyUI/user/` path that doesn't exist:

```bash
.venv/bin/python main.py \
  --base-directory "$DATA_DIR" \
  --database-url "sqlite:///$DATA_DIR/user/comfyui.db" \
  "$@"
```

### Platform stubs — triton & decord

Two packages required by ComfyUI-RMBG (SAM3) are unavailable on macOS/Python 3.13:

| Package | Reason unavailable | Fix |
|---|---|---|
| `triton` | NVIDIA CUDA kernel library — no macOS wheel | `scripts/install_stubs.sh` writes a stub |
| `decord` | No Python 3.13 / macOS wheel | `scripts/install_stubs.sh` writes a stub |

`run.sh` calls `scripts/install_stubs.sh` on every launch so stubs survive venv recreations. RMBG-SAM3 loads fully (43 nodes); GPU kernel operations via triton and video decoding via decord will raise `NotImplementedError` at runtime on this platform.

### groundingdino-py

Added to the venv bootstrap in `run.sh`. Required by `ComfyUI-RMBG/py/AILab_SegmentV2.py` for text-prompt segmentation. If installation fails on a given platform RMBG falls back gracefully.

## Performance

### Moody Zimage Pipeline

~360–420s per image (~3K output) on Apple Silicon MPS (128GB unified memory).

**Bottleneck**: SeedVR2 super-resolution accounts for ~68% of total time (~240–280s for the 7B DiT model).

**Optimization options**:

| Option | Time Saved | Trade-off |
|---|---|---|
| Skip SeedVR2 entirely | ~68% | No super-resolution; output at 2.5× instead of ~3K |
| Reduce UltimateSDUpscale to 2.0× | ~10s | Lower intermediate resolution |
| Reduce KSampler steps from 9 to 6-7 | ~10s | Slight quality loss (ZIT already distilled) |
| Use SeedVR2 GGUF (quantized) | Unknown | Lower precision, potentially faster inference |
| Enable mps-bitsandbytes FP8 | Potentially 30-50% on UNET | Experimental, needs testing |

### Flux 2 Klein 9B

~158 seconds per batch (4 images, 864×2016) on Apple Silicon MPS.
