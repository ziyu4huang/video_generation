# LoRA / LoKR Usage Guide

## zit_sda_v1 — Z-Image Turbo Diversity Adapter

**Format**: LoKR (Kronecker LoRA, LyCORIS format)
**Purpose**: Increase output diversity, alter character style/composition
**Path**: `models/lora/zit-sda-v1/zit_sda_v1.safetensors`

### Self-Test (A/B with Quality Metrics)

The LoRA self-test provides **objective, quantitative comparison** of LoRA impact. It generates paired images across multiple seeds with **identical settings** (same prompt, seed, steps, resolution) — the **only variable** is whether LoRA is loaded.

After generation, 7 no-reference quality metrics are computed per image (see [image-quality.md](image-quality.md)):
- **Sharpness** (Laplacian variance) — higher is better
- **Edge density** (Sobel gradient mean) — higher is better
- **Contrast** (luminance standard deviation) — higher is better
- **Noise** (MAD sigma) — lower is better
- **SNR** (signal-to-noise ratio in dB) — higher is better
- **Blockiness** (8×8 compression artifacts) — lower is better
- **Saturation** (HSV saturation std) — neutral

Output is a self-contained HTML file with:
- Aggregate quality table (averaged across all seeds) with winner highlighting and delta percentages
- Per-seed collapsible quality mini-tables
- Paired image voting interface (Prefer A / B / Tie / Skip)
- JSON export with quality data included

```bash
# Portrait prompt (close-up face)
run.py image --self-test sda

# Full-body fashion photography prompt
run.py image --self-test sda-fullbody

# Explicit review path with overrides
run.py image review lora --self-test zit-sda-v1 --seeds 42,123 --lora-scale 0.7

# Skip quality analysis (images + voting only)
run.py image review lora --self-test zit-sda-v1 --no-quality
```

### Quality Results — Portrait (4 seeds, scale=1.0)

| Metric | Baseline | SDA v1 | Δ | Winner |
|--------|----------|--------|---|--------|
| Sharpness | 97.9 | 91.7 | −6% | Baseline |
| Edge density | 20.3 | 19.5 | −4% | Baseline |
| Contrast | 64.7 | 62.3 | −4% | Baseline |
| Noise | 4.45 | 4.45 | 0% | Tie |
| SNR | 30.1 | 29.8 | −1% | Baseline |
| Blockiness | 10.3 | 9.95 | −3% | SDA v1 |
| Saturation | 42.9 | 41.6 | −3% | — |

### Quality Results — Full-body Fashion (4 seeds, scale=1.0)

| Metric | Baseline | SDA v1 | Δ | Winner |
|--------|----------|--------|---|--------|
| Sharpness | 757.4 | 960.1 | **+27%** | **SDA v1** |
| Edge density | 29.9 | 30.6 | +2% | **SDA v1** |
| Contrast | 60.1 | 53.9 | −10% | Baseline |
| Noise | 2.97 | 2.97 | 0% | Tie |
| SNR | 35.9 | 35.5 | −1% | Baseline |
| Blockiness | 15.5 | 15.1 | −3% | **SDA v1** |
| Saturation | 34.0 | 28.9 | −15% | — |

### Cross-Prompt Finding

SDA v1's effect **depends heavily on prompt type**:

| Prompt | Sharpness | Edges | Blockiness | Overall |
|--------|-----------|-------|------------|---------|
| Portrait (close-up face) | Baseline wins (−6%) | Baseline wins (−4%) | SDA wins (−3%) | Slight degradation |
| Full-body fashion | **SDA wins (+27%)** | **SDA wins (+2%)** | SDA wins (−3%) | Mixed but sharpness dominant |

**Conclusion**: SDA v1 at scale=1.0 improves sharpness and edge detail significantly on full-body compositions (clothing, hands, posture) but slightly degrades close-up portraits. Blockiness reduction is consistent across both. Consider:
- **Full-body / fashion**: SDA v1 recommended (sharpness +27%)
- **Portrait / close-up**: Use lower scale (0.5–0.7) or skip SDA
- **Both scenarios**: Blockiness improvement is universal

### Usage

```bash
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt "YOUR PROMPT" \
  --width 640 --height 960 --steps 9 --seed 42 \
  --lora-path python/mlx-movie-director/models/lora/zit-sda-v1/zit_sda_v1.safetensors \
  --lora-scale 0.49
```

> **Note**: moody-zimage-v7.5.json uses strength = **0.49** (not 1.0).

### LoKR Format

LoKR differs from standard LoRA (lora_A/B):
- **Standard LoRA**: `dW = B @ A * (alpha/rank)` — two low-rank matrices
- **LoKR**: `dW = kron(lokr_w1, lokr_w2) * scale` — Kronecker product

Kronecker product `kron([8x8], [480x480]) = [3840x3840]`, directly matching model attention dimensions, no low-rank decomposition needed.

### Alpha Value Special Case

`zit_sda_v1.safetensors` contains alpha ~ 9.999x10^9 (extremely large).
This is **not** a traditional LoRA alpha (cannot use alpha/rank as scale).
Correct approach: ignore alpha, use `kron(w1, w2) * user_scale` directly.

This is because w1/w2 are pre-scaled during training:
- Base weight std ~ 0.165
- kron delta std ~ 0.00069 (~0.4% of base weight, reasonable fine-tuning magnitude)

### Application Mechanism

1. Compute Kronecker product: `dW = kron(w1, w2) * user_scale`
2. For each target layer's quantized weight: dequantize -> add dW -> requantize
3. After applying all layers, execute QKV fusion (fuse_model())
4. Targets: layers 0-9 attention (Q/K/V/out), feed_forward (w1/w2/w3), adaLN_modulation

### Key Naming Mapping

| LoKR file key | MLX model path |
|--------------|--------------|
| `diffusion_model.layers.N.attention.to_q` | `layers.N.attention.to_q` |
| `diffusion_model.layers.N.attention.to_out.0` | `layers.N.attention.to_out` |
| `diffusion_model.layers.N.adaLN_modulation.0` | `layers.N.adaLN_modulation` |
| `diffusion_model.layers.N.feed_forward.w1` | `layers.N.feed_forward.w1` |

## Standard LoRA Support

`lora_utils.py` also supports traditional LoRA format (`lora_A/B` or `lora_down/up`),
using `LoRALinearWrapper` for dynamic inference-time injection. LoKR is baked into quantized weights.

## Adding Other LoRAs

Supports ComfyUI-standard LoRA `.safetensors` files. Key naming is auto-converted.
For naming mismatches, add mapping rules in `app/lora_utils.py` `_convert_lokr_key()` or `convert_unet_key_to_mlx()`.
