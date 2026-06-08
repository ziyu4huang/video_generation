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

### Quality Results — Portrait (4 seeds, scale=1.0, 2026-06-09)

| Metric | Baseline | SDA v1 | Δ | Winner |
|--------|----------|--------|---|--------|
| Sharpness (Laplacian σ²) | 97.9 | 91.7 | −6% | Baseline ✓ |
| Edge density (Sobel) | 20.3 | 19.5 | −4% | Baseline ✓ |
| Contrast (luminance σ) | 64.7 | 62.3 | −4% | Baseline ✓ |
| Noise (MAD σ) | 4.45 | 4.45 | 0% | Tie |
| SNR (dB) | 30.1 | 29.8 | −1% | Baseline ✓ |
| Blockiness (8×8) | 10.3 | 9.95 | −3% | **SDA v1 ✓** |
| Saturation σ | 42.9 | 41.6 | −3% | — |

### Quality Results — Full-body Fashion (4 seeds, scale=1.0, 2026-06-09)

| Metric | Baseline | SDA v1 | Δ | Winner |
|--------|----------|--------|---|--------|
| Sharpness (Laplacian σ²) | 757.4 | 960.1 | **+27%** | **SDA v1 ✓** |
| Edge density (Sobel) | 29.9 | 30.6 | +2% | **SDA v1 ✓** |
| Contrast (luminance σ) | 60.1 | 53.9 | −10% | Baseline ✓ |
| Noise (MAD σ) | 2.97 | 2.97 | 0% | Tie |
| SNR (dB) | 35.9 | 35.5 | −1% | Baseline ✓ |
| Blockiness (8×8) | 15.5 | 15.1 | −3% | **SDA v1 ✓** |
| Saturation σ | 34.0 | 28.9 | −15% | — |

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

## Usage

```bash
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt "YOUR PROMPT" \
  --width 640 --height 960 --steps 9 --seed 42 \
  --lora-path python/mlx-movie-director/models/lora/zit-sda-v1/zit_sda_v1.safetensors \
  --lora-scale 0.49
```

> **Note**: moody-zimage-v7.5.json uses strength = **0.49** (not 1.0).

## Why no MLX conversion?

LoRA files are converted on-the-fly at runtime (PyTorch → numpy → MLX bfloat16, in memory). This is fast (~1s for 162MB) because:

- LoRA weights are low-rank A/B matrices — small compared to the base model
- No quantization benefit — 4-bit would hurt quality for negligible savings
- Swappable — different LoRAs can be used per run without pre-converting each one

The base transformer (~3.6 GB) and text encoder (~2.3 GB) are pre-converted because they're large and always used; LoRA is an optional overlay.
