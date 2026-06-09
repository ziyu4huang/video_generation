# mlx-movie-director — BFS Face/Head Swap

BFS (Best Face Swap) uses Flux2 Klein 9B + a dedicated swap LoRA with
multi-image reference conditioning to swap faces between two images —
natively on Apple Silicon via MLX.  No ComfyUI required.

Source: [Alissonerdx/BFS-Best-Face-Swap](https://huggingface.co/Alissonerdx/BFS-Best-Face-Swap)

## How It Works

```
┌─────────────┐  ┌─────────────┐
│  Image 1    │  │  Image 2    │
│  (body)     │  │  (face)     │
└──────┬──────┘  └──────┬──────┘
       │                │
       └───────┬────────┘
               ▼
    ┌──────────────────────┐
    │  Flux2 Klein 9B      │
    │  + BFS LoRA (rank64) │
    │  + swap prompt       │
    └──────────┬───────────┘
               ▼
       ┌───────────────┐
       │  Result: body  │
       │  + swapped face│
       └───────────────┘
```

The BFS LoRA modifies 144 attention layers in the Klein 9B transformer,
enabling it to understand "Image 1 = body, Image 2 = face source" and
generate a new image combining both.

**Key detail**: The LoRA is applied at model init time (not generate time)
because Klein's distilled architecture fuses LoRA weights into the
transformer during loading.

## Usage

### Normal mode — swap two provided images

```bash
# Basic face swap
python/venv/bin/python run.py image faceswap \
  --input body.png --face source.png

# Head swap (includes hair)
python/venv/bin/python run.py image faceswap \
  --input body.png --face source.png --mode head

# Custom LoRA scale
python/venv/bin/python run.py image faceswap \
  --input body.png --face source.png --lora-scale 0.8

# Custom output dimensions
python/venv/bin/python run.py image faceswap \
  --input body.png --face source.png --width 768 --height 1152
```

### Test mode — auto-generate sources + review

```bash
python/venv/bin/python run.py image faceswap --self-test
```

Self-test mode runs 3 phases automatically:

| Phase | Pipeline | Purpose | ~Time |
|-------|----------|---------|-------|
| 1. Body image | ZImage (Moody V12.6) | Generate Asian JK girl portrait (seed=42) | ~12s |
| 2. Face image | Flux2 Klein T2I | Generate European woman close-up (seed=100) | ~5s |
| 3. Face swap | Flux2 Klein Edit + BFS LoRA | Combine body + face via swap prompt | ~57s |

If a VLM server (LM Studio with Qwen3-VL) is running at `localhost:1234`,
each image is automatically scored on a 1–10 scale across 6 dimensions
(overall, detail, sharpness, composition, prompt_adherence, artifacts).
Scores appear in the review HTML labels.

After all phases, an interactive HTML review page opens with 3 labeled
cards showing body, face, and swap result side-by-side.

## CLI Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--input IMAGE` | — | Target body image (Image 1). Required in normal mode. |
| `--face IMAGE` | — | Source face image (Image 2). Required in normal mode. |
| `--mode` | `face` | `face` = swap face only (keep hair), `head` = swap full head |
| `--lora NAME` | `bfs-head-v1-klein-9b` | BFS LoRA name (from `models/lora/`) or absolute path |
| `--lora-scale` | `1.0` | LoRA application strength |
| `--self-test` | off | Auto-generate body + face, run swap, open review HTML |
| `--seed` | `42` | RNG seed for reproducibility |
| `--steps` | `4` | Denoising steps (4 is typical for distilled Klein) |
| `--width` | `1024` | Output width |
| `--height` | `1536` | Output height (2:3 portrait default) |

## Models Required

| Model | Location | Size | Purpose |
|-------|----------|------|---------|
| BFS LoRA (rank-64) | `models/lora/bfs-head-v1-klein-9b/` | ~331 MB | Face swap adapter |
| Klein 9B INT8 | `models/transformer/klein-9b/` + `text_encoder/`, `vae/`, `tokenizer/` | ~17 GB | Base transformer |
| ZImage Moody V12.6 (test only) | `models/zimage/` | ~6 GB | Body source generation |
| Klein 9B INT8 (test only) | Same as above (reused) | ~17 GB | Face source generation |

## Dimension Notes

Source images should have the same aspect ratio as the desired output.
The default output is **1024×1536** (2:3 portrait) to match typical
portrait-oriented source images (640×960).

If the output aspect ratio differs from the source, mflux will
**stretch** (not crop) the reference images to fit — this causes
visible distortion.  For example, generating at 1024×1024 (square)
from 640×960 (portrait) sources makes the subject look wider/chubby.

**Rule of thumb**: Keep `width:height` ratio consistent between source
and output.  Common portrait ratios:

| Source | Output (2×) |
|--------|-------------|
| 640×960 | 1024×1536 |
| 512×768 | 1024×1536 |
| 768×1024 | 1024×1366 |

## Memory Management

Test mode runs three sequential phases, each loading a different model:

```
Phase 1: ZImagePipeline (~8 GB)  → body image  → unload + clear cache
Phase 2: Flux2KleinT2IPipeline (~17 GB) → face image → unload + clear cache
Phase 3: Flux2KleinPipeline + BFS LoRA (~17 GB) → faceswap result
```

Peak memory never exceeds ~17 GB (single large model + overhead).

In normal mode, only Phase 3 runs (the user provides pre-made images).

## Tips & Gotchas

### LoRA scale
Default `--lora-scale` is `1.0`. The BFS LoRA was trained at this scale.
Lower values (0.7–0.9) soften the swap effect; higher values may produce
artifacts. The `--lora-scale` argument is shared across all image subcommands
and defaults to `1.0` — safe for faceswap.

### Dimension matching
Source images should have the **same aspect ratio** as the desired output.
mflux stretches (not crops) reference images to fit output dimensions.
Mismatched ratios cause visible distortion (e.g., portrait source → square
output makes subjects look wide/chubby).

### Self-test results (2026-06-09)
Verified with VLM scoring:
- Body (ZImage): 8/10
- Face (Flux2 T2I): 9/10
- **FaceSwap result: 8/10**
- Total time: ~75 seconds

## Swap Prompts

### Face mode (default)

> Referring to Images 1 and 2, replace the person's face in Image 1
> with the face from Image 2, while keeping the natural hairstyle,
> natural lighting, and face skin color of the person in Image 1.

### Head mode

> Referring to Images 1 and 2, replace the person's face in Image 1
> with the face from Image 2, while keeping the natural hairstyle of
> Image 1, natural lighting, and face skin color consistency.

## Output Files

Each run produces:

```
output/output_YYYYMMDD_HHMMSS.png           # faceswap result
output/output_YYYYMMDD_HHMMSS.run.json      # full run configuration
output/output_YYYYMMDD_HHMMSS.manifest.json # timing, memory, results
```

Test mode additionally produces:

```
output/fs-test-YYYYMMDD_HHMMSS_body.png     # generated body source
output/fs-test-YYYYMMDD_HHMMSS_body.manifest.json
output/fs-test-YYYYMMDD_HHMMSS_face.png     # generated face source
output/fs-test-YYYYMMDD_HHMMSS_face.manifest.json
output/generation-review-YYYYMMDD_HHMMSS.html  # interactive review page
```
