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

# Multi-style sweep (8 prompt types)
run.py image --self-test sda-sweep

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

### Cross-Prompt Sweep (8 styles × 2 seeds, scale=1.0, 2026-06-09)

Full sweep across diverse image styles to discover where SDA helps vs hurts:

| Style | Baseline Sharpness | SDA v1 Sharpness | Δ | Winner |
|-------|--------------------|------------------|---|--------|
| **Street** (Tokyo night) | 1381 | 1743 | **+26%** | **SDA v1 ✓✓** |
| **Landscape** (mountains) | 745 | 878 | **+18%** | **SDA v1 ✓✓** |
| **Interior** (living room) | 736 | 857 | **+16%** | **SDA v1 ✓✓** |
| **Full-body** (fashion) | 774 | 865 | **+12%** | **SDA v1 ✓** |
| **Cyberpunk** (neon alley) | 360 | 388 | +8% | SDA v1 ✓ |
| **Animal** (red fox) | 231 | 227 | −1% | Tie |
| **Food** (pasta dish) | 388 | 367 | −5% | Baseline ✓ |
| **Portrait** (close-up) | 118 | 108 | −8% | Baseline ✓✓ |

**Pattern**: SDA v1 sharpness gain correlates with **scene complexity** (more elements = more benefit):

```
High complexity scenes ────────────────────────► SDA wins big (+12% to +26%)
  streets, landscapes, interiors, full-body

Low complexity / close-up ─────────────────────► SDA degrades (−1% to −8%)
  portraits, food, single-animal
```

### When to Use SDA v1

| Scenario | Recommendation | Reason |
|----------|---------------|--------|
| Street / urban photography | **Use SDA v1** | +26% sharpness, complex multi-element scenes |
| Landscape / nature | **Use SDA v1** | +18% sharpness, rich detail scenes |
| Interior / architecture | **Use SDA v1** | +16% sharpness, geometric+material detail |
| Full-body fashion | **Use SDA v1** | +12% sharpness, clothing/body detail |
| Cyberpunk / neon | **Use SDA v1** | +8% sharpness, moderate benefit |
| Wildlife / animal | Optional | Near-zero effect (−1%) |
| Food / macro | **Skip SDA v1** | −5% sharpness on close-up subjects |
| Portrait / close-up | **Skip SDA v1** | −8% sharpness on face detail |

Blockiness reduction is **universal** (−3% across all styles). If blockiness is the primary concern, SDA v1 can be used even on portraits at reduced scale (0.5–0.7).

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
