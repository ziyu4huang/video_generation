---
name: flux2-klein-face-head-swap
description: "Face/head swap workflow fixes — prompt tuning to preserve hair, SeedVR2 offload_device MPS config"
metadata:
  node_type: memory
  type: project
---

## Face/Head Swap Workflow (`flux2-klein-face-head-swap.json`)

### Pipeline Design
1. **Phase 1 — Bald source**: PainterFluxImageEdit (Node 183) takes source person B (rembg'd), prompt removes hair → KSampler → VAEDecode → bald person B
2. **Phase 2 — Crop**: AutoCropFaces Node 125 (face, scale=2) from bald B, Node 126 (head, scale=4) from original B → ifElse (Node 141: true=face, false=head)
3. **Phase 3 — Swap**: PainterFluxImageEdit (Node 184, 2_image) takes image1=target A + mask, image2=cropped face/head → KSampler → VAEDecode → final result

### Key Fix: Prompt Tuning (2026-06-06)

**Problem**: Original prompts explicitly said "remove the hair" / "remove the face", causing the model to produce bald heads even though the workflow was designed to preserve hair from image 1.

**Fix applied to both workflow files**:
- `flux2-klein-face-head-swap.json`
- `Flux 2 Klein Precise Face_Head Swap Final V2.json`

| Node | Role | Old Prompt (bald) | New Prompt (hair preserved) |
|---|---|---|---|
| 199 | Head swap prompt | "remove the hair, and replace the person's head and face..." | "replace the person's face in Image 1 with the face from Image 2, while keeping the natural hairstyle of Image 1, natural lighting, and face skin color consistency." |
| 200 | Face swap prompt | "remove the face and replace the person's head and face..." | "replace the person's face in Image 1 with the face from Image 2, while keeping the natural hairstyle, natural lighting, and face skin color of the person in Image 1." |

Node 127 (reference prompt for Phase 1 bald generation) was NOT changed — it still intentionally makes the source bald to get a clean face crop.

### SeedVR2 MPS Config Fix (same session)

**Problem**: `SeedVR2LoadDiTModel` had `offload_device="none"` with `cache_model=True` → ValueError.

**Fix**: Set `offload_device="cpu"` for all SeedVR2 DiT nodes (46, 53, 97, 177) across 3 workflow files.

**Why**: For Apple Silicon (unified memory), `offload_device` must be `"cpu"` when `cache_model=True`. BlockSwap auto-disables on MPS. Recommended settings for M5 Max 128GB:
- model: seedvr2_ema_7b_fp16, device: mps, offload_device: cpu, blocks_to_swap: 0, attention_mode: sdpa

### Related
- [[seedvr2-offload-device-mps]]
