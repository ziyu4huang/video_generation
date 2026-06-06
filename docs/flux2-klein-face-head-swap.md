# Flux 2 Klein Face/Head Swap Workflow

Image-based face or head swapping using **Flux 2 Klein 9B** with the **PainterFluxImageEdit** node for multi-image reference editing.

## Workflow Files

| File | Description |
|---|---|
| `flux2-klein-face-head-swap.json` | Simplified version |
| `Flux 2 Klein Precise Face_Head Swap Final V2.json` | Full version with SeedVR2 upscaling |

## Pipeline

```
Image A (target) ──┐
                   │
Image B (source) ──┼── Phase 1: Make B bald (clean face crop)
                   │       ↓
                   │   Phase 2: AutoCropFaces → face or head crop
                   │       ↓
                   ├── Phase 3: PainterFluxImageEdit (2_image) → swap
                   │       ↓
                   └── KSampler → VAEDecode → Final result
                           ↓
                    (Optional) SeedVR2 upscale
```

### Phase 1 — Create bald source (clean face extraction)

| Node | Type | Purpose |
|---|---|---|
| 105 | `LoadImage` | Source person B (face to swap in) |
| 115 | `ImageScaleByAspectRatio V2` | Scale to output size limit |
| 116 | `easy imageRemBg` | Remove background (white) |
| 183 | `PainterFluxImageEdit` (1_image) | Edit with prompt: "remove the hair...make them bald" |
| 123 | `KSampler` | euler, 4 steps, CFG 1 |
| 124 | `VAEDecode` | Decode → bald person B |

The reference prompt (Node 127) intentionally makes person B bald to produce a clean face crop without hair interference.

### Phase 2 — Crop face or head

| Node | Type | Setting | Purpose |
|---|---|---|---|
| 125 | `AutoCropFaces` | scale=2 | Crop **face** from bald person B |
| 126 | `AutoCropFaces` | scale=4 | Crop **head** from original person B (with hair) |
| 108 | `easy ifElse` | controlled by Node 141 | Choose face or head crop |
| 141 | `PrimitiveBoolean` | `true`=face, `false`=head | Swap mode selector |

### Phase 3 — Main face/head swap

| Node | Type | Purpose |
|---|---|---|
| 128 | `ImageScaleByAspectRatio V2` | Scale target image A with mask |
| 130 | `easy ifElse` | Auto-detect mask or use full image mask |
| 184 | `PainterFluxImageEdit` (2_image) | image1=target A + mask, image2=cropped face/head |
| 119 | `KSampler` | euler, 4 steps, CFG 1 |
| 106 | `VAEDecode` | Final output |

### Phase 4 — Optional SeedVR2 upscaling

Nodes 172, 177, 175 (SeedVR2 DiT + VAE + Upscaler) — **bypassed by default**. Enable for 4K output.

## Key Settings

### Swap Mode (Node 141)

| Value | Mode | Image 2 Source | Prompt |
|---|---|---|---|
| `true` | Face swap | Bald face crop (Node 125) | Node 200 |
| `false` | Head swap | Head crop with hair (Node 126) | Node 199 |

### Prompts (tuned 2026-06-06)

| Node | Mode | Prompt |
|---|---|---|
| 127 | Reference (Phase 1) | "remove the hair of the person in image 1, remove the long hair, and edit it to make them bald, while keeping everything else unchanged." |
| 199 | Head swap (Phase 3) | "Referring to Images 1 and 2, replace the person's face in Image 1 with the face from Image 2, while keeping the natural hairstyle of Image 1, natural lighting, and face skin color consistency." |
| 200 | Face swap (Phase 3) | "Referring to Images 1 and 2, replace the person's face in Image 1 with the face from Image 2, while keeping the natural hairstyle, natural lighting, and face skin color of the person in Image 1." |

### Output Size

Node 191 (`PrimitiveInt`) controls max resolution. Default: 1536. Lower to 1280/1024 if VRAM limited.

## Prompt Tuning History

### 2026-06-06 — Fix bald head output

**Problem**: Original prompts for Phase 3 explicitly said "remove the hair" / "remove the face", causing the model to produce bald heads. The workflow was designed to extract a clean face (Phase 1 bald), then swap it while preserving hair from the original image — but the prompts counteracted this by telling the model to remove hair.

**Fix**: Removed "remove the hair" / "remove the face" from Phase 3 prompts (Nodes 199, 200). Replaced with explicit instruction to "keep the natural hairstyle of Image 1".

**Applied to**: Both `flux2-klein-face-head-swap.json` and `Flux 2 Klein Precise Face_Head Swap Final V2.json`.

## Required Custom Nodes

| Node | Package | Purpose |
|---|---|---|
| `PainterFluxImageEdit` | Comfyui-PainterFluxImageEdit | Multi-image reference editing with Flux 2 |
| `AutoCropFaces` | ComfyUI-AutoCropFaces | Face/head detection and cropping |
| `easy imageRemBg` | ComfyUI-Easy-Use | Background removal |
| `easy ifElse` | ComfyUI-Easy-Use | Conditional routing |
| `LayerUtility: ImageScaleByAspectRatio V2` | ComfyUI_LayerStyle | Aspect-ratio-aware scaling |
| `ImageConcanate` | ComfyUI-Easy-Use | Side-by-side comparison |
| `Image Comparer` | rgthree-comfy | Before/after comparison |
| `Fast Groups Bypasser` | rgthree-comfy | Toggle workflow sections |
| `SeedVR2VideoUpscaler` | ComfyUI-SeedVR2_VideoUpscaler | Optional upscaling |
| `ReservedVRAMSetter` | ComfyUI-ReservedVRAM | VRAM reservation for MPS |
| `VRAMCleanup` | comfyui_memory_cleanup | Memory cleanup between phases |

## Shared Models

Same as base Flux 2 Klein 9B setup:

| File | Location |
|---|---|
| `flux-2-klein-9b-bf16.safetensors` | `models/diffusion_models/` |
| `qwen_3_8b_fp8mixed.safetensors` | `models/text_encoders/` |
| `flux2-vae.safetensors` | `models/vae/` |

### SeedVR2 (optional)

| File | Location |
|---|---|
| `seedvr2_ema_3b_fp16.safetensors` | `models/SEEDVR2/` |
| `ema_vae_fp16.safetensors` | `models/SEEDVR2/` |

### SeedVR2 MPS Configuration (Apple Silicon)

| Parameter | Value | Reason |
|---|---|---|
| `device` | `mps` | Metal Performance Shaders |
| `offload_device` | `cpu` | Required for `cache_model=True` |
| `blocks_to_swap` | `0` | Auto-disabled on unified memory |
| `attention_mode` | `sdpa` | Only MPS-compatible mode |

⚠️ **Must** set `offload_device="cpu"` — `"none"` causes `ValueError` when `cache_model=True`.
