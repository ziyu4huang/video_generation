# mlx-movie-director — Anime2Real Style Transfer

Convert anime-style images to realistic output while preserving the original
character's identity (hair color, clothing, facial features, pose) using
Flux2KleinEdit reference conditioning + anime2real LoRA — natively on
Apple Silicon via MLX.

LoRA source: [JayZ2015/anime-girl-turned-into-real-person](https://civitai.com/models/2349471)
(CivitAI model 2349471, ⭐5 stars, 160+ reviews).

## How It Works

```
┌──────────────┐
│  Anime Input │
│  (any style) │
└──────┬───────┘
       │ VAE Encode
       ▼
┌──────────────────┐    ┌─────────────────────┐
│  Reference       │    │  Noise Latents      │
│  Latent Tokens   │    │  + Text Prompt      │
└──────┬───────────┘    └──────┬──────────────┘
       │ concat (not mix)      │
       └──────────┬────────────┘
                  ▼
       ┌──────────────────────┐
       │  Flux2 Klein 9B      │
       │  + anime2real LoRA   │
       │  (8 denoising steps) │
       └──────────┬───────────┘
                  ▼
         ┌───────────────┐
         │  Realistic     │
         │  Output Image  │
         └───────────────┘
```

Unlike traditional img2img (which mixes clean latents with noise and loses
identity at high denoise), this approach uses Flux2KleinEdit's reference
conditioning:

1. The anime input is VAE-encoded into reference latent tokens
2. These tokens are **concatenated** with noise latents (not mixed)
3. The model "sees" the original character at every denoising step
4. The anime2real LoRA biases the transformer toward realistic output

Result: the output looks like a realistic version of the original anime
character, preserving hair color, outfit, etc.

## Usage

```bash
# Basic — uses verified best defaults (civitai-chinese)
python/venv/bin/python python/mlx-movie-director/run.py image anime2real \
  --input-image anime.png

# With explicit options
python/venv/bin/python python/mlx-movie-director/run.py image anime2real \
  --input-image anime.png \
  --realism-style civitai-chinese \
  --steps 8 \
  --seed 42

# Use English 3D Game style (good for cute/colorful anime)
python/venv/bin/python python/mlx-movie-director/run.py image anime2real \
  --input-image anime.png \
  --realism-style 3d-game \
  --ref-strength 0.2
```

## CLI Options

| Option | Default | Description |
|--------|---------|-------------|
| `--input-image` | (required) | Path to anime input image |
| `--realism-style` | `civitai-chinese` | Style preset (see below) |
| `--steps` | 8 (per preset) | Denoising steps |
| `--anime2real-lora-scale` | 1.0 (per preset) | LoRA strength |
| `--ref-strength` | 1.0 | Reference conditioning strength (0.0–1.0) |
| `--anime2real-ref-count` | 1 | Number of reference copies (1–4) |
| `--seed` | 42 | Random seed |
| `--skip-preprocess` | (flag) | Skip canny/edge preprocessing (recommended) |
| `--prompt` | (per preset) | Override the style prompt |

## Realism Style Presets

| Preset | Prompt | LoRA Scale | Steps | Notes |
|--------|--------|------------|-------|-------|
| **`civitai-chinese`** (default) | `转年轻的亚洲少女写实风格` | 1.0 | 8 | A/B winner 5/5 across all archetypes |
| `3d-game` | UE5 game character render… | 0.7 | 8 | Good for cute/colorful anime |
| `photorealistic` | DSLR portrait photograph… | 1.0 | 8 | Plain photorealism |
| `semi-realistic` | Semi-realistic illustration… | 0.85 | 6 | Stylized balance |

## Verified Best Parameters

Based on 7 rounds of A/B testing (2026-06-09 to 2026-06-10):

| Round | Test | Winner | Key Finding |
|-------|------|--------|-------------|
| v1 | 4 styles × 4 prompts | 3D Game (3/4) | UE5 aesthetic beats photorealistic |
| v2 | ref_strength 1.0→0.05 | 0.05 (2/2) | Lower = more freedom but identity drift |
| v3 | ref_strength 0.2/0.25/0.15/0.1 | — | Narrowed safe range |
| v4 | ref_strength 0.3→0.05 | 0.05 (2/2) | Confirmed 0.2 as safe minimum |
| v5 | CivitAI vs ours (2 prompts) | CN prompt (2/2) | Chinese trigger phrase wins |
| v6 | 5 prompts × 5 configs | Mixed | Style depends on archetype |
| **v7** | **5 prompts × 5 configs** | **C (5/5)** | **Pure CivitAI wins everything** |

### Final defaults (v7 winner):

```
--realism-style civitai-chinese  Chinese trigger phrase "转年轻的亚洲少女写实风格"
--anime2real-lora-scale 1.0      Full LoRA strength
--ref-strength 1.0               Full reference conditioning
--steps 8                        8 denoising steps
--anime2real-ref-count 1         Single reference copy
```

## Tips

### Hair Color Preservation
- At `--ref-strength 1.0` (default), hair color is well-preserved for most
  prompts. Some drift may occur on warrior-type prompts (silver → dark) but
  overall quality still wins in A/B testing.
- At `--ref-strength 0.2`, identity drift is more pronounced: pink → brown,
  silver → dark. Use only if you specifically want the model to have more
  freedom.
- At `--ref-strength 0.05`, identity is often lost entirely.

### Style Selection by Anime Archetype
- **Serious/dramatic** anime (portrait, warrior) → `civitai-chinese` (default)
  produces the best realistic conversion.
- **Cute/colorful** anime (magical girl, idol, chibi) → consider `3d-game`
  which preserves more of the cute aesthetic while still converting to
  realistic. The user noted: "動漫迷要可愛風格，不要太過真實".

### Step Count
- **4 steps**: Too soft, lacks detail. Fast but low quality.
- **8 steps**: Crisp detail, good balance of quality and speed (~30–70s per
  image on M-series Mac).

### Preprocessing
- Always use raw anime image as input (do NOT use canny/edge detection).
  The `--skip-preprocess` flag ensures this. Edge detection destroys the
  color information needed for identity preservation.

### Reference Count
- `--anime2real-ref-count 1` is sufficient. Using 3 copies makes generation
  3× slower with only marginal quality improvement.

### Output Dimensions
- Output matches input dimensions (aligned to nearest 16px). For best
  results, use portrait-oriented images (e.g., 640×960).

## Self-Test (A/B Testing)

Built-in self-test configs for evaluating anime2real quality and comparing
parameter settings.

### Running a self-test

```bash
# Primary: diversity validation (10 archetypes, ~15-25 min)
python/venv/bin/python python/mlx-movie-director/run.py image review anime2real \
  --self-test anime2real-diversity

# CivitAI comparison: 5 prompts × 5 columns = 25 images
python/venv/bin/python python/mlx-movie-director/run.py image review anime2real \
  --self-test anime2real-civitai-compare

# Male boundary: 3 male prompts × 4 columns (~12-18 min)
python/venv/bin/python python/mlx-movie-director/run.py image review anime2real \
  --self-test anime2real-male-boundary

# Step count sweep: 3 prompts × 4 columns (~10-18 min)
python/venv/bin/python python/mlx-movie-director/run.py image review anime2real \
  --self-test anime2real-steps-sweep

# Edge cases: 4 prompts × 2 columns (~8-12 min)
python/venv/bin/python python/mlx-movie-director/run.py image review anime2real \
  --self-test anime2real-edge-cases
```

### Available self-test configs

| Config | Alias | Prompts | Columns | Est. Time |
|--------|-------|---------|---------|-----------|
| `anime2real-diversity` | `a2r-diversity` | 10 | 2 | 15-25 min |
| `anime2real-male-boundary` | `a2r-male` | 3 | 4 | 12-18 min |
| `anime2real-steps-sweep` | `a2r-steps` | 3 | 4 | 10-18 min |
| `anime2real-edge-cases` | `a2r-edges` | 4 | 2 | 8-12 min |
| `anime2real-civitai-compare` | — | 5 | 5 | 20-35 min |
| `anime2real-ref-strength` | `a2r-str` | 2 | 4 | 8-14 min |
| `anime2real-ab` | `a2r-ab` | 4 | 4 | 15-25 min |
| `anime2real-ref` | `a2r-ref` | 4 | 2-4 | 10-20 min |
| `anime2real-review` | `a2r-review` | 4 | 2 | 8-14 min |
| `anime2real-pipeline` | `a2r-pipe` | 4 | 4 | 15-25 min |

### Test prompts

15 anime archetypes covering diverse styles, genders, and edge cases:

**Core female archetypes:**

| Prompt | Hair | Outfit | Setting |
|--------|------|--------|---------|
| `anime-portrait` | Pink | School uniform | Simple background |
| `anime-warrior` | Silver | Dark armor | Battlefield |
| `anime-magical` | Blonde twin-tails | Magical girl outfit | Pastel |
| `anime-cyberpunk` | Blue short | Neon jacket | Futuristic city |
| `anime-idol` | Auburn | Idol costume | Concert stage |

**Diversity expansion (female):**

| Prompt | Hair | Outfit | Key Test |
|--------|------|--------|----------|
| `anime-chibi` | Pink twin pigtails | Frilly dress, balloon | Chibi/SD proportions |
| `anime-historic` | Black straight | Red kimono, fan | 90s retro + dark hair |
| `anime-fantasy-fullbody` | White→purple gradient | Gold filigree armor, cape | Full-body + complex bg |
| `anime-gothic` | Midnight blue wavy | Gothic lolita dress, corset | Dark palette |
| `anime-sideprofile` | Red flowing | Summer dress | Non-frontal face |

**Male boundary testing:**

| Prompt | Hair | Outfit | Key Test |
|--------|------|--------|----------|
| `anime-male-swordsman` | Dark green messy | Samurai + haori | Male + action pose |
| `anime-male-scholar` | Brown neat | School uniform, glasses | Male + accessories |
| `anime-male-cyberpunk` | White spiky | Techwear jacket, cybernetic eye | Male + cyberpunk |

**Edge cases:**

| Prompt | Hair | Outfit | Key Test |
|--------|------|--------|----------|
| `anime-animal-ears` | Silver + cat ears | Oversized sweater, cat tail | Non-human features |
| `anime-mecha-pilot` | Orange tomboyish | Pilot plugsuit, glowing circuits | Mechanical + human |

### HTML voting UI

Self-test generates an HTML file with:
- Side-by-side image comparison (click to zoom)
- Short VLM captions per image
- Voting buttons (pick best per row)
- Text notes per row
- Export: Copy JSON or Save File with all votes

The UI supports 🌐 EN/中文 language toggle (persisted in localStorage).

## Known Limitations

- **Female LoRA bias**: The LoRA is trained on female anime characters
  (`anime-girl-turned-into-real-person`). The Chinese trigger phrase contains
  少女 (young girl). Male characters may be converted toward female output.
  Use `anime2real-male-boundary` test to evaluate this behavior — it compares
  少女 (girl) vs 人 (person) prompt variants to distinguish prompt bias from
  LoRA weight bias.

- **Chibi/SD proportions**: Exaggerated head-to-body ratios may not convert
  well since the LoRA expects normal human proportions.

- **Non-human features**: Cat ears, tails, and mechanical elements may be
  removed or significantly altered during realistic conversion.

- **Dark palettes**: Gothic/dark anime styles may lose atmosphere in
  conversion since the LoRA biases toward standard realistic tones.

## Related

- [faceswap-bfs.md](faceswap-bfs.md) — BFS face/head swap pipeline
- [i2i.md](i2i.md) — Image-to-image pipeline
- [profile.md](profile.md) — Character profile sheet generation
