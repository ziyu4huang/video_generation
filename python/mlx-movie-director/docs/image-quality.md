# Image Quality Analysis

No-reference image quality metrics for objective, quantitative comparison of generated images. Uses pure signal processing (OpenCV + NumPy) — no AI models needed.

## Metrics (7 no-reference)

| Metric | Method | Higher = Better? | What it measures |
|--------|--------|-------------------|------------------|
| **Sharpness** | Laplacian variance (σ²) | ↑ | Overall image clarity and detail |
| **Edge density** | Sobel gradient mean | ↑ | Amount of edge/detail in the image |
| **Contrast** | Luminance standard deviation | ↑ | Tonal range and dynamic spread |
| **Noise** | MAD (Median Absolute Deviation) σ | ↓ | Sensor/compression noise level |
| **SNR** | Signal-to-noise ratio (dB) | ↑ | How much signal vs noise |
| **Blockiness** | 8×8 DCT block artifacts | ↓ | JPEG/compression quantization artifacts |
| **Saturation** | HSV saturation std | — | Color vibrancy spread (neutral) |

Implementation: `app/quality_metrics.py` — `analyze_frame(gray, bgr)` returns the 7-value dict.

## Usage

### Standalone analysis

Analyze one or more existing images:

```bash
# Single image
run.py image quality --quality-inputs output/image.png

# A/B comparison of two images
run.py image quality --quality-inputs a.png b.png --quality-labels "Default,UltraFlux"

# Save JSON report
run.py image quality --quality-inputs a.png b.png --quality-json report.json
```

Output: terminal table + self-contained HTML report (auto-opens in browser).

### VAE self-test

Generate the same prompt with different VAEs, then compare quality:

```bash
run.py image quality --self-test --test-prompt portrait --seed 42
```

### LoRA A/B review

Paired comparison across multiple seeds — baseline vs LoRA adapter. Quality metrics are **on by default**:

```bash
# Built-in test: portrait prompt, 4 seeds
run.py image --self-test sda

# Built-in test: full-body fashion prompt
run.py image --self-test sda-fullbody

# Skip quality (images + voting only)
run.py image review lora --self-test zit-sda-v1 --no-quality

# Custom seeds and scale
run.py image review lora --self-test zit-sda-v1 --seeds 42,123 --lora-scale 0.7
```

Output: self-contained HTML with:
- Aggregate quality table (averaged across all seeds) with winner highlighting and delta %
- Per-seed collapsible quality mini-tables
- Paired image voting interface (Prefer A / B / Tie / Skip)
- JSON export with quality data included

### VAE review

Same pattern as LoRA review, comparing different VAE decoders:

```bash
run.py image --self-test ultraflux
```

## Programmatic API

```python
from app.commands.image-quality import analyze_image

report = analyze_image("output/image.png")
# Returns: {"image": "...", "resolution": [640, 960], "metrics": {
#     "sharpness": 456.7,
#     "edge_density": 29.3,
#     "contrast": 58.2,
#     "noise_sigma": 2.97,
#     "snr_db": 35.8,
#     "blockiness": 15.1,
#     "saturation_std": 34.5,
# }}
```

## Integration Points

Quality analysis is integrated into three review workflows:

| Workflow | Command | Quality by default? |
|----------|---------|---------------------|
| Standalone analysis | `run.py image quality --quality-inputs ...` | Always on |
| VAE review | `run.py image --self-test ultraflux` | Always on |
| LoRA review | `run.py image --self-test sda` | On by default, `--no-quality` to skip |

The LoRA review adds `--no-quality` as an opt-out because quality analysis adds ~1s per image (8 images = ~8s) on top of generation time. For quick visual checks, `--no-quality` skips the analysis.

## HTML Output

All review modes produce a self-contained HTML file (base64-embedded images, inline CSS/JS):

- **Aggregate table**: metrics averaged across all seeds, winner highlighted with delta %
- **Per-seed tables**: collapsible per-pair mini-tables (LoRA review)
- **Voting interface**: Prefer A / Prefer B / Tie / Skip (LoRA review)
- **Export**: JSON download with quality data per pair

The HTML is designed to be shareable — no external dependencies, works offline.

## Metric Interpretation Tips

- **Sharpness** is the most reliable single metric for perceived quality. Laplacian variance correlates well with human sharpness perception.
- **Edge density** complements sharpness — it measures detail quantity, not clarity.
- **Contrast** can be misleading alone (a high-contrast noisy image scores well). Always compare with noise/SNR.
- **Blockiness** detects 8×8 DCT quantization artifacts common in JPEG compression and VAE decode.
- **Saturation** is neutral — neither high nor low is inherently better. It depends on artistic intent.
- When comparing two images, look for **consistent winners across metrics** — a single metric win may be noise.

## Known Metric Limitations

Validated via `--self-test degradation` on real generated outputs (10/10 image checks pass, 9/9 video checks pass).

### Sharpness paradox with noise

The "sharpness" metric (Laplacian variance σ²) measures **total high-frequency energy**, not just edge clarity. Adding Gaussian noise dramatically increases the value:

| Variant | Sharpness | Why |
|---------|-----------|-----|
| Original | 279.0 | Clean edges |
| Gaussian Noise σ=30 | **8035.7** | Noise adds massive HF energy |
| Gaussian Blur σ=3 | 2.2 | Blur removes HF energy |

**Implication**: A higher sharpness value does NOT always mean better quality. Always cross-check with noise_sigma and SNR. If noise_sigma is also high, the "sharpness" is noise, not detail.

### JPEG blockiness unreliability at high resolution

The blockiness metric measures mean absolute differences at 8-pixel grid boundaries. On high-resolution images (≥2 megapixels), JPEG compression artifacts are spread thin and may not increase measured blockiness:

| Variant | Blockiness | Expected |
|---------|-----------|----------|
| Original (2084×1460) | 12.4 | — |
| JPEG Q=5 | 11.4 | ↑ but actually ↓ |
| JPEG Q=40 | 12.0 | ↑ but actually ↓ |

**Why**: JPEG smooths the image, which can *reduce* boundary differences at the 8px grid. The metric works better at lower resolutions where compression artifacts are more concentrated.

### JPEG sharpness unreliability on video

On video frames, JPEG compression creates ringing artifacts near edges that increase Laplacian variance:

| Variant | Sharpness | Edge density |
|---------|-----------|--------------|
| Original | 216.5 | 58.3 |
| JPEG Q=5 | **372.1** ↑ | **55.6** ↓ |

Sharpness increases (JPEG ringing) but edge density correctly decreases (detail loss). **For JPEG quality assessment, prefer edge_density over sharpness.**

### Noise metric and JPEG

JPEG compression smooths high-frequency noise, so heavily compressed images may show *lower* noise_sigma than the original. This is correct behavior — JPEG is removing noise along with detail.

### Trend validation vs pairwise checks

- **Steps-sweep** uses monotonic trend validation (4→8→14→20 steps should show quality ↑)
- **Degradation** uses pairwise checks (Blur vs Original, Noise vs Original) — different degradation types aren't ordered by quality, so monotonic trends don't apply

---

## Self-Test Modes

### Image Quality (`run.py image quality --self-test <mode>`)

| Mode | Command | What it does | Needs MLX? |
|------|---------|--------------|------------|
| `vae` (default) | `--self-test` | Generate with Default VAE vs UltraFlux VAE, compare 7 metrics | Yes |
| `steps-sweep` | `--self-test steps-sweep` | Generate at 4/8/14/20 steps, validate quality trends | Yes |
| `degradation` | `--self-test degradation` | Apply Blur/Noise/JPEG/Downscale to existing image, validate metrics detect changes | No |

```bash
# VAE comparison (needs MLX + UltraFlux VAE installed)
run.py image quality --self-test --test-prompt portrait --seed 42

# Steps sweep — shows how quality improves with more denoising steps
run.py image quality --self-test steps-sweep --test-prompt portrait --seed 42

# Degradation test — fast, validates all metrics on synthetic degradations
run.py image quality --self-test degradation --quality-inputs output/image.png
```

**Degradation test checks (10 total)**:
1. Blur: sharpness < Original
2. Blur: edge_density < Original
3. Blur: contrast < Original
4. Noise: noise_sigma > Original
5. Noise: snr_db < Original
6. JPEG Q=5: sharpness < Original
7. JPEG Q=5: sharpness < JPEG Q=40
8. JPEG Q=5: edge_density < Original
9. Downscale: sharpness < Original
10. Downscale: edge_density < Original

### Video Quality (`run.py video quality --self-test <mode>`)

| Mode | Command | What it does | Needs MLX? |
|------|---------|--------------|------------|
| `default` | `--self-test` | Generate Distilled vs HQ, compare 10 metrics | Yes |
| `steps-sweep` | `--self-test steps-sweep` | Generate at 4/8/12/16 stage1_steps, validate quality trends | Yes |
| `degradation` | `--self-test degradation` | Apply per-frame Blur/Noise/JPEG/Downscale, validate metrics | No |

```bash
# Default: Distilled (8 steps) vs HQ (15 steps)
run.py video quality --self-test --test-prompt forest-hiker --seed 42

# Steps sweep — 4 quality levels, same prompt/seed
run.py video quality --self-test steps-sweep --test-prompt forest-hiker --seed 42

# Degradation test — validates spatial + temporal metrics
run.py video quality --self-test degradation --quality-inputs output/video.mp4
```

**Degradation test checks (9 total)**:
1. Blur: sharpness < Original
2. Blur: edge_density < Original
3. Noise: noise_sigma > Original
4. Noise: snr_db < Original
5. JPEG Q=5: edge_density < Original
6. JPEG Q=5: edge_density < JPEG Q=40
7. JPEG Q=5: noise_sigma < Original (JPEG smooths HF)
8. Downscale: sharpness < Original
9. Downscale: edge_density < Original
