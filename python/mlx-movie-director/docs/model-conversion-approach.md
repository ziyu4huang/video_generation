# Model Conversion Approach

This document describes the standard workflow for converting, optimizing, and managing models in `mlx-movie-director`.

## Philosophy: On-the-Fly → Validate → Pre-Quantize → Reclaim

Every new model follows this lifecycle:

### Phase 1: On-the-Fly (Development)

- Load model in its native format (BF16, FP16, FP32)
- Apply quantization at runtime (`nn.quantize()` or mflux `quantize=N`)
- Fast iteration — no disk commitment, easy to test different quantization levels
- **When to use:** First integration of a new model, experimenting with quality/speed tradeoffs

### Phase 2: A/B Validation

- Generate identical outputs with old and new approaches (same seed, prompt, resolution)
- Compute PSNR/SSIM metrics for numerical comparison
- Human visual review for quality acceptance
- **Gate:** Do not proceed to pre-quantization until quality is validated

### Phase 3: Pre-Quantized Conversion

- Convert model once to the target format (MLX INT8, MLX 4-bit, etc.)
- Save as safetensors in the appropriate `models/<category>/<instance>/` directory
- Update `manifest.json` (format, size_bytes) and `README.md`
- Run `check-manifests -v` to validate
- **When to use:** Model is stable, quality validated, and will be used repeatedly

### Phase 4: Reclaim Disk

- Remove old unoptimized model files
- Keep `manifest.json` and `README.md` for provenance
- Create `REMOVED` marker file (see below)
- **When to use:** After A/B test confirms the new format produces equivalent output

---

## REMOVED Marker Convention

When model files are deleted (e.g., after converting from PyTorch to MLX), a `REMOVED` marker file is placed in the model directory alongside `manifest.json`.

### File: `models/<category>/<instance>/REMOVED`

```json
{
  "removed_at": "2026-06-07T12:00:00Z",
  "reason": "Replaced by MLX BF16 conversion",
  "original_format": "pytorch-fp32",
  "original_files": ["diffusion_pytorch_model.safetensors"],
  "original_size_bytes": 167666902,
  "reconvert_command": "convert.py --vae"
}
```

### Pipeline Behavior

The `check_model_available()` function in `app/config.py` checks for the `REMOVED` marker before loading any model. If found, it prints the reason and the re-conversion command, then exits with an error.

This ensures that:
- Disk space is reclaimed when models are replaced
- The system fails gracefully if a removed model is needed again
- The user knows exactly how to restore the model

---

## Conversion Checklist

For each model conversion, ensure:

- [ ] **Source identified**: Where does the original model come from? (HF cache, ComfyUI, local)
- [ ] **Target format chosen**: `mlx-bf16`, `mlx-8bit`, `mlx-4bit-gs32`, etc.
- [ ] **Weight mapping verified**: PyTorch → MLX key names, Conv2d transpose rules
- [ ] **Conversion command added**: New flag in `convert.py`
- [ ] **Manifest updated**: `format`, `size_bytes` match actual files
- [ ] **README updated**: Source, conversion command, file listing
- [ ] **check-manifests passes**: `run.py check-manifests -v` reports no errors
- [ ] **Pipeline updated**: Loading code uses the new format
- [ ] **A/B test passed**: Quality confirmed via visual or numerical comparison
- [ ] **Old files cleaned up**: REMOVED marker created

---

## Current Model Inventory

| Model | Category | Format | Size | Status | Source Deleted |
|-------|----------|--------|------|--------|---------------|
| zimage-moody-v126 | transformer | mlx-4bit-gs32 | 3.6 GB | ✅ Pre-quantized | ✅ ComfyUI source (11 GB) deleted |
| klein-9b | transformer | mlx-8bit | 9.6 GB | ✅ Pre-quantized | ✅ HF cache (32 GB) deleted |
| seedvr2-7b | transformer | mlx-4bit-gs32 | 4.8 GB | ✅ Pre-quantized | ✅ ComfyUI source (15 GB) deleted |
| ltx-2.3-connector | text_encoder | mlx-4bit-gs32 | 6.3 GB → 1.9 GB | ✅ Pre-quantized | ✅ ComfyUI source deleted |
| qwen3-4b | text_encoder | mlx-4bit-gs32 | 2.3 GB | ✅ Pre-quantized | ✅ ComfyUI source (7.5 GB) deleted |
| qwen3-8b | text_encoder | mlx-8bit | 8.0 GB | ✅ Pre-quantized | ✅ HF cache (via klein-9b) deleted |
| flux-ae | vae | mlx-bf16 | 160 MB | ✅ Converted (was pytorch-fp32) | ✅ PyTorch file deleted, REMOVED marker |
| flux2-klein | vae | mlx-8bit | 158 MB | ✅ Pre-quantized | ✅ HF cache (via klein-9b) deleted |
| seedvr2-vae | vae | mlx-bf16 | 478 MB | — INT8 negligible savings (Conv3d-skipped) | ✅ ComfyUI source (478 MB) deleted |
| ultraflux-ae | vae | mlx-bf16 | 335 MB → 168 MB | ✅ Converted (was pytorch-fp32) | ✅ PyTorch file deleted, REMOVED marker |
| qwen3 | tokenizer | hf-tokenizer | 15 MB | ✅ No conversion needed | N/A (HF download) |
| qwen3-klein | tokenizer | hf-tokenizer | 11 MB | ✅ No conversion needed | ✅ HF cache (via klein-9b) deleted |
| zit-sda-v1 | lora | safetensors-fp32 | 162 MB | — Low priority | Kept (still in ComfyUI) |
| zimage-turbo-fun-union-2.1 | controlnet | safetensors-bf16 | 2.0 GB | ⚠️ Deprecated — replaced by MLX 4-bit | ✅ Cleaned up (REMOVED + dir deleted) |

**Total disk recovered: ~94 GB** (34 GB ComfyUI sources + 49 GB HF caches + 4.4 GB GGUF + 4.2 GB connector BF16→4-bit + 2.0 GB deprecated ControlNet + 0.2 GB ultraflux-ae FP32→BF16)

### Also Deleted

- `seedvr2_ema_7b-Q4_K_M.gguf` (4.4 GB) — GGUF quantized, not used by MLX pipeline
- `models--black-forest-labs--FLUX.2-klein-9b-fp8/` (8.8 GB) — FP8 variant not needed
- `models--Comfy-Org--flux2-klein-9B/` (8.1 GB) — duplicate of black-forest-labs version

### Kept

- `models--black-forest-labs--FLUX.2-klein-4B/` (15 GB) — not yet converted, may need later
- `models--Tongyi-MAI--Z-Image-Turbo/` (160 MB) — tokenizer/VAE source
- `comfyui_data/models/loras/zit_sda_v1.safetensors` (162 MB) — LoRA still used at runtime
- `comfyui_data/models/upscale_models/4xNomosWebPhoto_RealPLKSR.pth` (28 MB) — ESRGAN still used

---

## Pipeline Gaps

### ltx-2.3-connector: Runtime loading missing `nn.quantize()`

The `ltx-2.3-connector` was converted from BF16 (6.3 GB) to 4-bit GS32 (1.9 GB) via `convert.py --ltx-connector`. Quality was A/B validated (cosine sim 1.0 video, 0.996 audio).

**Problem:** The runtime loading code at `vendor/ltx-pipelines-mlx/utils/blocks.py:97-101` calls `load_weights()` directly on a plain `TextEncoderConnector` without first calling `nn.quantize()` / `apply_quantization()`. With pre-quantized 4-bit weights (keys include `.scales`, `.biases`), this will fail with `ValueError`.

**Fix:** Apply the same two-step pattern used by the DiT transformer loader:

```python
# Before (broken):
connector_weights = load_split_safetensors(path, prefix="connector.")
self._feature_extractor.connector.load_weights(list(connector_weights.items()))

# After (fixed):
connector_weights = load_split_safetensors(path, prefix="connector.")
apply_quantization(self._feature_extractor.connector, connector_weights)
self._feature_extractor.connector.load_weights(list(connector_weights.items()))
```

The `apply_quantization()` call (from `ltx_core_mlx.utils.weights`) auto-detects quantized layers by checking for `.scales` keys in the weight dict and calls `nn.quantize()` on those layers. If the weights are BF16 (no `.scales`), `apply_quantization()` is a no-op — so the fix is backward-compatible.

**Status:** ✅ Fixed across all loading sites:
- `blocks.py:97-101` — runtime pipeline loader ✅
- `model_loader.py:232-234` — trainer loader ✅
- `test_generate_real_prompt.py:78-81` — test loader ✅
- `diagnose_text_encoder.py:130-137` — diagnostic script ✅
