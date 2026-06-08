# Z-Image Workflow — Civitai Workflow → mlx-movie-director

> Plan approved: 2026-06-08
> Source: [Z-Image Base & Turbo Workflow v14.0](https://civitai.com/models/2184844/z-image-base-and-turbo-workflow-i2it2i-low-or-high-vram)

## Context

The Civitai Z-Image Base & Turbo Workflow v14.0 is a comprehensive ComfyUI workflow for
photorealistic image generation using the ZImageTurbo model. It chains multiple processing
stages: base generation → face detailer → post-processing → upscaling, with features like
multi-LoRA, seed variance, prompt enhancement, and draft mode.

The goal is to port all of these features into `mlx-movie-director` as a multi-stage pipeline
orchestrator, making the same pro-grade results achievable from a single CLI command on
Apple Silicon.

**Status**: ~60% of infrastructure already exists. The ZImagePipeline supports T2I/I2I, LoRA,
latent upscale, ESRGAN/SeedVR2 upscaling, and ControlNet. What's missing is the orchestration
layer and several individual feature implementations.

---

## Phase 1: Foundation — Post-Processing & CLI Enhancements

### 1.1 Create `app/postprocess.py` — Image Post-Processing Filters

Pure numpy/PIL image processing module with these classes:

| Filter | Description | Complexity |
|--------|-------------|------------|
| `FilmGrain` | Gaussian noise (intensity 0–0.03), optional vignette & temperature shift | LOW |
| `Sharpening` | Contrast Adaptive Sharpening (CAS) + unsharp mask | LOW |
| `NoiseCleaner` | Bilateral filter (`cv2.bilateralFilter`) for noise reduction; JPEG blocking reduction via blur+sharpen | LOW |
| `LUTGrading` | Parse `.cube` 3D LUT files, trilinear interpolation to remap colors | MEDIUM |
| `SkinContrast` | Detect skin-tone pixels via HSV range, apply CLAHE selectively | LOW-MEDIUM |

**Dependencies**: `opencv-python` (for CLAPE, bilateral filter)

**LUT files**: Download `NaturalBoost.cube` or create equivalent; store in `models/lut/`

### 1.2 Integrate I2I into `image t2i` CLI

The ZImagePipeline already supports I2I. The RunConfig already has `input_image`,
`denoise_strength`, `latent_upscale` fields. The `_shared.py` already loads `input_image`.

**Missing**: No `--input` flag in `add_common_generation_args()`.

- **File**: `app/commands/_shared.py` — add `--input`, `--denoise-strength`, `--latent-upscale`

### 1.3 Add `--draft` Flag

Quick preview: fewer steps (4), smaller resolution (512×512).

- **File**: `app/commands/_shared.py` — add `--draft` flag
- **File**: `app/run_config.py` — add `draft: bool = False` (schema v11)
- **File**: `app/commands/image-t2i.py` — override steps/width/height when `--draft`

---

## Phase 2: Multi-LoRA & Seed Variance

### 2.1 Multi-LoRA Support

Extend `lora_path` (single) → `lora_paths` (list) with individual scales.

**Files**: `run_config.py` (schema v11), `_shared.py`, `pipeline.py`

### 2.2 Seed Variance Enhancer

Add noise to text embeddings during early denoising steps for more diverse outputs.

**New file**: `app/seed_variance.py`

**Integration**: Modify `@mx.compile` step function to accept a flag for noisy/clean embedding.

---

## Phase 3: Face Detailer

Lightweight face detailer using `mediapipe` for detection, VAE re-encode + low-strength
re-denoise for enhancement, alpha-blend composite back.

**New file**: `app/face_detailer.py`
**Dependencies**: `mediapipe`

---

## Phase 4: LUT Color Grading & Post-Processing Chain

`.cube` 3D LUT parser with trilinear interpolation. Wire all post-processing filters into
a configurable `PostProcessChain`.

---

## Phase 5: Workflow Orchestrator

Multi-stage pipeline orchestrator that chains: base gen → face detail → post-process → upscale.

**New files**: `app/workflow.py`, `app/commands/image-workflow.py`
**CLI**: `run.py image workflow --prompt "..." --face-detail --film-grain 0.02 --upscale`

Per-generation subfolder output with all intermediate images and combined manifest.

---

## File Changes Summary

### New Files
| File | Purpose |
|------|---------|
| `app/postprocess.py` | FilmGrain, Sharpening, LUTGrading, SkinContrast, NoiseCleaner, PostProcessChain |
| `app/face_detailer.py` | FaceDetailer (mediapipe + crop + re-denoise + composite) |
| `app/seed_variance.py` | SeedVarianceEnhancer (noisy text embeddings) |
| `app/workflow.py` | WorkflowOrchestrator, WorkflowResult |
| `app/commands/image-workflow.py` | CLI command: `run.py image workflow` |

### Modified Files
| File | Changes |
|------|---------|
| `app/run_config.py` | Schema v11: multi-LoRA, draft, seed variance, face detail, postprocess |
| `app/pipeline.py` | Multi-LoRA loop, seed variance, keep-alive option |
| `app/commands/_shared.py` | `--input`, `--draft`, multi-LoRA, prompt enhancement |
| `app/commands/image.py` | Register `workflow` sub-action |
| `app/config.py` | Add `LUT_DIR` constant |
| `app/pipeline_types.py` | Add `WorkflowResult` dataclass |
