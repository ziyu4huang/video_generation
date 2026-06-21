# dark-beast-dbzit9 — ZImage-Turbo Transformer (4-bit MLX)

ZImage Turbo finetune optimized for bold stylized imagery — comic, anime, and action art.

- **Source**: CivitAI (https://civitai.com/models/2242173/dark-beast-or?modelVersionId=2788849) (baseModel ZImageTurbo)
- **Converted**: `convert.py --zit-checkpoint darkBeast_dbzit9DIMRclaw_fp8.safetensors`
- **Size**: 3.8 GB
- **Quantization**: 4-bit, group_size=32

## Best For

- Comic book and graphic novel art (bold ink outlines, halftone dots, flat cel colors)
- Manga and anime action scenes (speed lines, dramatic expressions, screentone shading)
- Noir / dark-atmosphere illustration (high-contrast ink wash, heavy shadows)
- Retro pulp sci-fi and fantasy covers (bold outlines, bright primary colors)

**Not ideal for**: photorealistic portraits, soft gradients, or natural skin tones.

## Sample Prompts

```
comic book panel, superhero woman flying over neon city skyline, cape flowing,
bold ink outlines, flat cel colors, halftone dot pattern, dynamic action pose,
dramatic upward angle, retro Marvel style
```

```
graphic novel noir detective, trench coat, rainy city street at night,
dramatic shadows, ink wash style, high contrast black and white with red accents,
moody atmosphere, cinematic composition
```

```
manga action panel, fierce warrior girl, katana slash, speed lines,
explosive energy burst, dramatic expression, screentone shading, Japanese manga style
```

```
retro 1960s sci-fi comic book cover, astronaut exploring alien planet,
giant colorful alien creature, rocket ship in background, bold outlines,
bright primary colors, halftone texture, vintage pulp fiction aesthetic
```

## Usage

```bash
python/venv/bin/python python/mlx-movie-director/run.py \
  image t2i --pipeline zimage --transformer dark-beast-dbzit9 \
  --prompt 'your prompt here' \
  --width 768 --height 1024 --steps 20 --cfg-scale 4.5 --seed 42
```

## Notes

- Format: 4-bit quantized MLX (group_size=32) — faster and lighter than 8-bit models
- Shares text encoder (qwen3-4b), tokenizer (qwen3), and VAE (zimage-ae) with other ZImage models
- Tested: `--steps 20 --cfg-scale 4.5` produces clean comic/manga style output
