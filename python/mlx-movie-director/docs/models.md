# Models Reference

Three pipelines, each with its own model set:

| Pipeline | Command | Models Location | Quantization |
|----------|---------|----------------|--------------|
| **Z-Image Turbo** (Moody V12.6) | `run.py generate` | `models/` (local, pre-converted) | Pre-converted 4-bit on disk |
| **Flux2 Klein** (9B) | `run.py profile` | `models/` (local, pre-converted INT8) | Pre-quantized INT8 on disk |
| **LTX-2.3 Video** (22B) | `run.py video generate` | `models/` (local, pre-converted Q8) | Pre-quantized Q8 on disk |
| **SeedVR2** (7B) | `run.py upscale --method seedvr2` | `models/` (local, pre-converted) | Pre-converted 4-bit on disk |

## JSON File System

Each model instance directory (`models/<category>/<instance>/`) contains two JSON files with distinct roles and origins.

### manifest.json — Private Metadata (Always Ours)

**Origin:** Created by `convert.py` or manually. Never downloaded from HuggingFace.

**Purpose:** Model registry metadata — identity, source, format, size, compatibility.

**Always safe to edit.** Identified by `_comment` field at top.

| Field | Type | Description |
|-------|------|-------------|
| `_comment` | string | Documentation marker — identifies this as our private file |
| `name` | string | Instance name (must match directory name) |
| `type` | string | Category: `transformer`, `text_encoder`, `vae`, `lora`, `tokenizer`, `audio` |
| `arch` | string | Architecture family (e.g. `flux2-klein-9b`, `zimage-turbo`, `ltx-2.3`) |
| `format` | string | Weight format (e.g. `mlx-4bit-gs32`, `mlx-8bit`, `safetensors-bf16`, `hf-tokenizer`) |
| `description` | string | Human-readable one-line description |
| `source` | string | Origin repo or URL |
| `compatible_with` | string[] | Instance names or arch IDs this model works with |
| `size_bytes` | int | Total size of weight files in bytes |
| `created_at` | string | ISO-8601 timestamp |
| `hf_repo` | string | *(optional)* HuggingFace repo ID for download |
| `hf_filename` | string | *(optional)* Specific filename in HF repo |
| `source_url` | string | *(optional)* Direct URL (e.g. Civitai) |
| `convert_flag` | string | *(optional)* `convert.py` flag to re-create (e.g. `--transformer`) |
| `weight_file` | string | *(optional)* Override weight filename (default: `model.safetensors`) |
| `pipeline` | string[] | *(optional)* Pipeline names this model belongs to |
| `trigger_words` | string[] | *(optional)* LoRA trigger words (e.g. `["style1", "style2"]`) |
| `test_prompt` | string | *(optional)* LoRA reference test prompt |
| `recommended_scale` | float | *(optional)* Recommended LoRA weight (e.g. `0.6`) |

### config.json — Model Architecture Config (Two Origins)

**Origin varies — check for `_comment` to tell them apart:**

| Origin | How to identify | Editable? |
|--------|----------------|-----------|
| **Downloaded from HuggingFace** | Has HF metadata (`_class_name`, `_diffusers_version`, `architectures`, `model_type`, `transformers_version`) — no `_comment` field | ❌ No — do not modify |
| **Created by us** (convert.py) | Has `_comment` field: *"Architecture config created by mlx-movie-director..."* | ✅ Yes — safe to edit |

**Purpose:** Defines model architecture parameters (layer counts, dimensions, channels) needed by MLX loading code.

### Directory Layout Example

```
models/transformer/klein-9b/
├── manifest.json          # Our private metadata (has _comment)
├── config.json            # From HuggingFace (has _class_name, _diffusers_version)
├── model.safetensors      # Weights
└── README.md              # Human docs

models/transformer/seedvr2-7b/
├── manifest.json          # Our private metadata (has _comment)
├── config.json            # Our config (has _comment: "created by mlx-movie-director")
├── model.safetensors      # Weights
└── README.md              # Human docs
```

Validated by `run.py check-manifests`.

## Pipeline 1: Z-Image Turbo (local models)

All model paths and defaults are configured in [`app/config.py`](../app/config.py).

### Directory Layout

```
python/mlx-movie-director/models/
├── transformer/         # Z-Image Moody V12.6 (4-bit MLX)
│   ├── config.json
│   ├── model.safetensors        (~3.6 GB)
│   └── README.md
├── text_encoder/        # Qwen3-4B (4-bit MLX)
│   ├── config.json
│   ├── model.safetensors        (~2.3 GB)
│   └── README.md
├── tokenizer/           # Qwen2.5 BPE tokenizer
│   ├── tokenizer.json           (~11 MB, fast tokenizer)
│   ├── tokenizer_config.json
│   ├── tmp/                     # slow tokenizer fallback (not needed at runtime)
│   └── README.md
├── vae/                 # AutoencoderKL (Flux/Z-Image)
│   ├── config.json
│   ├── model.safetensors        (~160 MB, MLX BF16)
│   ├── REMOVED_PyTORCH_VAE      # marker: old PyTorch file removed
│   └── README.md
├── seedvr2_dit_7b/      # SeedVR2 upscaler transformer
├── seedvr2_vae/         # SeedVR2 VAE
└── lora/                # LoRA adapters (optional, applied at runtime)
    ├── zit_sda_v1.safetensors   (~162 MB)
    └── README.md
```

### Source → Converted Mapping

| Component | Source (ComfyUI) | Converted (MLX) | How |
|-----------|-----------------|-----------------|-----|
| **Transformer** | ~~`comfyui_data/.../moody-porn-v12.6_00001_.safetensors`~~ (deleted, 11 GB) | `models/transformer/model.safetensors` (~3.6 GB) | `convert.py --transformer` — key remap + 4-bit quantize |
| **Text Encoder** | ~~`comfyui_data/.../qwen_3_4b.safetensors`~~ (deleted, 7.5 GB) | `models/text_encoder/model.safetensors` (~2.3 GB) | `convert.py --text-encoder` — 4-bit quantize |
| **Tokenizer** | [Tongyi-MAI/Z-Image-Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) HuggingFace | `models/tokenizer/` (~7 MB) | `convert.py --tokenizer` — download |
| **VAE** | [Tongyi-MAI/Z-Image-Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) HuggingFace | `models/vae/flux-ae/` (~160 MB) | `convert.py --vae` (download) + `convert.py --vae-mlx` (convert to MLX BF16) |
| **LoRA** | `comfyui_data/models/loras/zit_sda_v1.safetensors` (~162 MB) | Used directly (no conversion needed) | Runtime in-memory PyTorch → MLX |
| **Upscale** | `comfyui_data/models/upscale_models/4xNomosWebPhoto_RealPLKSR.pth` (~28 MB) | Used directly (PyTorch MPS) | No conversion — spandrel loads .pth on MPS |

> **Note:** ComfyUI source files for transformer, text encoder, seedvr2-dit, and seedvr2-vae have been deleted after A/B validation confirmed MLX conversions are equivalent. Source models were community fine-tunes not available from public HuggingFace repos — to re-convert, you'd need to re-acquire the original ComfyUI checkpoints.

### Defaults in Code

#### `app/config.py` — Paths

```python
SRC_TRANSFORMER    = comfyui_data/models/diffusion_models/moody-porn-v12.6_00001_.safetensors
SRC_TEXT_ENCODER   = comfyui_data/models/text_encoders/qwen_3_4b.safetensors
TRANSFORMER_DIR    = models/transformer/
TEXT_ENCODER_DIR   = models/text_encoder/
TOKENIZER_DIR      = models/tokenizer/
VAE_DIR            = models/vae/
```

#### `run.py` — CLI Defaults

| Flag | Default | Source |
|------|---------|--------|
| `--lora-path` | None (no LoRA) | `models/lora/zit_sda_v1.safetensors` if used |
| `--upscale-model` | `comfyui_data/models/upscale_models/4xNomosWebPhoto_RealPLKSR.pth` | `DEFAULT_UPSCALE_MODEL` in `run.py` |

#### `app/config.py` — Architecture Configs

**Transformer** (`TRANSFORMER_CONFIG`):

| Param | Value |
|-------|-------|
| dim | 3840 |
| in_channels | 16 |
| n_layers | 30 |
| n_refiner_layers | 2 |
| n_heads / n_kv_heads | 30 |
| cap_feat_dim | 2560 |
| rope_theta | 256.0 |
| t_scale | 1000.0 |

**Text Encoder** (`TEXT_ENCODER_CONFIG`):

| Param | Value |
|-------|-------|
| hidden_size | 2560 |
| intermediate_size | 9728 |
| num_attention_heads | 32 |
| num_key_value_heads | 8 (GQA) |
| num_hidden_layers | 36 |
| head_dim | 128 |
| vocab_size | 151,936 |

### Reproduce All Models

```bash
# One-time conversion (order matters: tokenizer/vae first, then heavy conversions)
./python/venv/bin/python python/mlx-movie-director/convert.py --tokenizer
./python/venv/bin/python python/mlx-movie-director/convert.py --vae
./python/venv/bin/python python/mlx-movie-director/convert.py --text-encoder
./python/venv/bin/python python/mlx-movie-director/convert.py --transformer

# LoRA — copy from ComfyUI (no conversion needed)
cp comfyui_data/models/loras/zit_sda_v1.safetensors python/mlx-movie-director/models/lora/
```

---

## Pipeline 2: Flux2 Klein 9B (local pre-quantized INT8)

Used by `run.py profile` for character profile sheet generation with reference image conditioning.
All components are pre-converted to INT8 and stored locally in `models/`. No HuggingFace download needed at runtime.

### Components

| Component | Model | Disk (INT8) | Location |
|-----------|-------|-------------|----------|
| **Transformer** | Flux2Transformer2DModel (32 heads, 8+24 layers) | 9.2 GB | `models/transformer/klein-9b/` |
| **Text Encoder** | Qwen3ForCausalLM (4096 hidden, 36 layers) | 7.7 GB | `models/text_encoder/qwen3-8b/` |
| **VAE** | AutoencoderKLFlux2 | 158 MB | `models/vae/flux2-klein/` |
| **Tokenizer** | Qwen3 BPE | 11 MB | `models/tokenizer/qwen3-klein/` |

**Total on disk:** ~17 GB INT8 (was ~32 GB BF16 in HF cache).

### Loading: Symlink Assembly

mflux requires a single root dir with `transformer/`, `text_encoder/`, `vae/`, `tokenizer/` subdirs.
Since components are scattered across category dirs, a temp symlink assembly is created at load time:

```python
# flux2_pipeline.py creates /tmp/klein9b_XXX/ with symlinks to each component
assembly_dir = tempfile.mkdtemp(prefix="klein9b_")
os.symlink(cfg.KLEIN_9B_TRANSFORMER_DIR, os.path.join(assembly_dir, "transformer"))
# ... same for text_encoder, vae, tokenizer
model = Flux2KleinEdit(model_path=assembly_dir, quantize=None)  # pre-quantized
```

### Key Config

| Component | Key Params |
|-----------|------------|
| Transformer | `attention_head_dim: 128`, `num_attention_heads: 32`, `num_layers: 8`, `num_single_layers: 24`, `joint_attention_dim: 12288`, `in_channels: 128`, `guidance_embeds: false` |
| Text Encoder | `hidden_size: 4096`, `intermediate_size: 12288`, `num_hidden_layers: 36`, `architectures: ["Qwen3ForCausalLM"]` |
| VAE | `scaling_factor: 0.3611`, `shift_factor: 0.1159`, `block_out_channels: [128, 256, 512, 512]` |

### Reproduce

```bash
/Users/huangziyu/.local/bin/python3.13 convert.py --klein-9b
```

### Historical: HF Cache Cleanup

After conversion, the HF cache (~32 GB) can be deleted:
```bash
rm -rf ~/.cache/huggingface/hub/models--black-forest-labs--FLUX.2-klein-9B
```

---

## Pipeline 3: LTX-2.3 Video (local pre-converted Q8)

Used by `run.py video generate` for text-to-video, image-to-video, and audio-to-video generation with joint audio. All components are pre-converted and stored locally in `models/`. The inference engine is the vendored `vendor/ltx-2-mlx` submodule with runtime monkey-patches.

### Components

| Component | Model | Disk (Q8) | Location |
|-----------|-------|-----------|----------|
| **Transformer** | LTX-2.3 22B DiT (48 layers, audio+video) | ~22 GB | `models/transformer/ltx-2.3-dev-q8/` |
| **LoRA** | Distilled LoRA (384-dim) | — | `models/lora/ltx-2.3-distilled/` |
| **Text Encoder** | Gemma 12B connector | — | `models/text_encoder/ltx-2.3-connector/` |
| **VAE** | LTX VAE encoder + decoder + spatial upscaler | — | `models/vae/ltx-2.3-vae/` |
| **Audio** | Audio VAE + BigVGAN vocoder | — | `models/audio/ltx-2.3-audio/` |

### Loading: Flat Symlink Assembly

ltx-2-mlx expects all weights in a single flat directory (HF-repo layout). Components are scattered across `models/<category>/<instance>/`, so a temp directory with symlinks is created at load time:

```python
# ltx_pipeline.py creates /tmp/ltx2_XXX/ with symlinks to each component file
assembly_dir = tempfile.mkdtemp(prefix="ltx2_")
os.symlink("models/transformer/ltx-2.3-dev-q8/transformer-dev.safetensors",
           os.path.join(assembly_dir, "transformer-dev.safetensors"))
# ... all components
pipeline = TI2VidTwoStagesPipeline(model_dir=assembly_dir, low_memory=True)
```

Assembly dir survives for the pipeline's lifetime (block-streaming mode memory-maps weights lazily). Cleaned up on `close()` / `__del__`.

### Vendor Patches

The submodule stays at clean upstream HEAD. Six monkey-patches in `app/vendor_patches.py` fix bugs at import time:

| # | Fix | Impact |
|---|-----|--------|
| 1–2 | MLX 0.31.2 `.at[strided].add()` Metal bug | Audio vocoder/BWE crash fix |
| 3 | AudioVAEDecoder causal frame crop | Off-by-3 frames in mel |
| 4 | `av_ca_timestep_scale_multiplier` 1.0→1000.0 | AV cross-attention gate (zeroed speech without it) |
| 5 | Load config from `embedded_config.json` | Reads correct values from checkpoint |
| 6 | `audio_stage1_only` parameter | Capture stage-1 audio before stage-2 overwrites |

See [`docs/ltx-pipeline.md`](ltx-pipeline.md) for full details.

### Config Paths

```python
# app/config.py
LTX_TRANSFORMER_DIR  = models/transformer/ltx-2.3-dev-q8/
LTX_LORA_DIR         = models/lora/ltx-2.3-distilled/
LTX_TEXT_ENCODER_DIR = models/text_encoder/ltx-2.3-connector/
LTX_VAE_DIR          = models/vae/ltx-2.3-vae/
LTX_AUDIO_DIR        = models/audio/ltx-2.3-audio/
```

### Reproduce

```bash
# Download and prepare components (see model-conversion-approach.md)
run.py video prepare-models    # or manual download + organize
```

---

## External Sources

| Model | HuggingFace | Notes |
|-------|-------------|-------|
| Z-Image Turbo | [Tongyi-MAI/Z-Image-Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) | Tokenizer + VAE + architecture reference |
| Qwen3-4B | [Qwen/Qwen3-4B](https://huggingface.co/Qwen/Qwen3-4B) | Text encoder for Z-Image pipeline |
| Flux2 Klein 9B | [black-forest-labs/FLUX.2-klein-9B](https://huggingface.co/black-forest-labs/FLUX.2-klein-9B) | Transformer + VAE + text encoder + tokenizer |
| LTX-2.3 MLX Q8 | [dgrauet/ltx-2.3-mlx-q8](https://huggingface.co/dgrauet/ltx-2.3-mlx-q8) | Full video pipeline (transformer, VAE, audio, text encoder) |
| LTX-2-MLX source | [dgrauet/ltx-2-mlx](https://github.com/dgrauet/ltx-2-mlx) | Vendored submodule — inference engine |
| Moody V12.6 DPO | Community fine-tune on ComfyUI | Transformer base model |
| 4xNomosWebPhoto | [NomosWebPhoto_RealPLKSR](https://openmodeldb.info/models/4xNomosWebPhoto_RealPLKSR) | ESRGAN upscaler |

## Defaults in Code

### `app/config.py` — Paths

```python
SRC_TRANSFORMER    = comfyui_data/models/diffusion_models/moody-porn-v12.6_00001_.safetensors
SRC_TEXT_ENCODER   = comfyui_data/models/text_encoders/qwen_3_4b.safetensors
TRANSFORMER_DIR    = models/transformer/
TEXT_ENCODER_DIR   = models/text_encoder/
TOKENIZER_DIR      = models/tokenizer/
VAE_DIR            = models/vae/
```

### `run.py` — CLI Defaults

| Flag | Default | Source |
|------|---------|--------|
| `--lora-path` | None (no LoRA) | `models/lora/zit_sda_v1.safetensors` if used |
| `--upscale-model` | `comfyui_data/models/upscale_models/4xNomosWebPhoto_RealPLKSR.pth` | `DEFAULT_UPSCALE_MODEL` in `run.py` |

### `app/config.py` — Architecture Configs

**Transformer** (`TRANSFORMER_CONFIG`):

| Param | Value |
|-------|-------|
| dim | 3840 |
| in_channels | 16 |
| n_layers | 30 |
| n_refiner_layers | 2 |
| n_heads / n_kv_heads | 30 |
| cap_feat_dim | 2560 |
| rope_theta | 256.0 |
| t_scale | 1000.0 |

**Text Encoder** (`TEXT_ENCODER_CONFIG`):

| Param | Value |
|-------|-------|
| hidden_size | 2560 |
| intermediate_size | 9728 |
| num_attention_heads | 32 |
| num_key_value_heads | 8 (GQA) |
| num_hidden_layers | 36 |
| head_dim | 128 |
| vocab_size | 151,936 |

## Reproduce All Models

```bash
# One-time conversion (order matters: tokenizer/vae first, then heavy conversions)
./python/venv/bin/python python/mlx-movie-director/convert.py --tokenizer
./python/venv/bin/python python/mlx-movie-director/convert.py --vae
./python/venv/bin/python python/mlx-movie-director/convert.py --text-encoder
./python/venv/bin/python python/mlx-movie-director/convert.py --transformer

# LoRA — copy from ComfyUI (no conversion needed)
cp comfyui_data/models/loras/zit_sda_v1.safetensors python/mlx-movie-director/models/lora/
```

## External Sources

| Model | HuggingFace | Notes |
|-------|-------------|-------|
| Z-Image Turbo | [Tongyi-MAI/Z-Image-Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) | Tokenizer + VAE + architecture reference |
| Qwen3-4B | [Qwen/Qwen3-4B](https://huggingface.co/Qwen/Qwen3-4B) | Text encoder (used as ComfyUI checkpoint) |
| Moody V12.6 DPO | Community fine-tune on ComfyUI | Transformer base model |
| 4xNomosWebPhoto | [NomosWebPhoto_RealPLKSR](https://openmodeldb.info/models/4xNomosWebPhoto_RealPLKSR) | ESRGAN upscaler |
