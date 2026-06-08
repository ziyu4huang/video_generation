# LoRA Adapters

Low-rank adapters for the Z-Image transformer. Applied at runtime — no pre-conversion needed (see [lora_utils.py](../../app/lora_utils.py)).

## Files

| File | Size | Description |
|------|------|-------------|
| `zit_sda_v1.safetensors` | ~162 MB | Z-Image Style Diversity Adapter v1 |

## zit_sda_v1 — Source

Copied from the ComfyUI moody-zimage workflow's LoRA collection:

```
comfyui_data/models/loras/zit_sda_v1.safetensors
```

Used in the `moody-zimage-v7.5.json` ComfyUI workflow to increase output diversity while maintaining the moody photorealistic style.

## Self-Test (A/B with Quality Metrics)

The LoRA self-test generates paired images (baseline vs LoRA) across multiple seeds with **identical settings** — same prompt, seed, steps, resolution. The **only difference** is whether LoRA is loaded. It then computes 7 no-reference quality metrics per image for objective comparison.

```bash
# Portrait prompt (close-up)
run.py image --self-test sda

# Full-body fashion photography prompt
run.py image --self-test sda-fullbody

# With overrides
run.py image review lora --self-test zit-sda-v1 --seeds 42,123 --lora-scale 0.7

# Skip quality analysis (faster, images only)
run.py image review lora --self-test zit-sda-v1 --no-quality
```

Output: self-contained HTML with paired images, voting interface, per-seed collapsible quality tables, and aggregate quality comparison.

### Quality Metrics (portrait, 4 seeds averaged, 2026-06-09)

| Metric | Baseline | SDA v1 | Δ | Winner |
|--------|----------|--------|---|--------|
| Sharpness (Laplacian σ²) | 97.9 | 91.7 | −6% | Baseline ✓ |
| Edge density (Sobel) | 20.3 | 19.5 | −4% | Baseline ✓ |
| Contrast (luminance σ) | 64.7 | 62.3 | −4% | Baseline ✓ |
| Noise (MAD σ) | 4.45 | 4.45 | 0% | Tie |
| SNR (dB) | 30.1 | 29.8 | −1% | Baseline ✓ |
| Blockiness (8×8) | 10.3 | 9.95 | −3% | **SDA v1 ✓** |
| Saturation σ | 42.9 | 41.6 | −3% | — |

**Finding**: SDA v1 at scale=1.0 slightly reduces sharpness, edge density, and contrast vs baseline.
It does reduce blockiness (fewer compression artifacts). The effect is subtle (~3–6%).
Consider testing at lower scale (0.5–0.7) or with full-body prompts (`--self-test sda-fullbody`)
to find scenarios where diversity adds value.

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt "moody portrait photo" \
  --lora-path python/mlx-movie-director/models/lora/zit-sda-v1/zit_sda_v1.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt "moody portrait photo" \
  --lora-path python/mlx-movie-director/models/lora/zit-sda-v1/zit_sda_v1.safetensors \
  --lora-scale 0.8
```

## Why no MLX conversion?

LoRA files are converted on-the-fly at runtime (PyTorch → numpy → MLX bfloat16, in memory). This is fast (~1s for 162MB) because:

- LoRA weights are low-rank A/B matrices — small compared to the base model
- No quantization benefit — 4-bit would hurt quality for negligible savings
- Swappable — different LoRAs can be used per run without pre-converting each one

The base transformer (~3.6 GB) and text encoder (~2.3 GB) are pre-converted because they're large and always used; LoRA is an optional overlay.
