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
