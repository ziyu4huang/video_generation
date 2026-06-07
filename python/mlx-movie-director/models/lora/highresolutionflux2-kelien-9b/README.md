# highresolutionflux2-kelien-9b — LoRA Adapter (flux2-klein-9b)

Enhances image detail, sharpness, and overall resolution quality when used with
the Flux2 Klein 9B distilled model on Apple Silicon. Produces visibly crisper
skin texture, finer hair detail, and higher-fidelity output compared to the
base model alone.

Source: [Civitai — High Resolution](https://civitai.com/models/2436859/high-resolution?modelVersionId=2760799)

## Files

| File | Size | Description |
|------|------|-------------|
| `HighResolutionFlux2-Kelien-9B.safetensors` | ~79 MB | LoRA weights (flux2-klein-9b, bf16) |

## Effect

Applied to **144 transformer layers** (224/224 keys matched). The LoRA
modifies attention and feed-forward weights to prioritize fine detail
reproduction. No trigger words required — the effect is always active
when the LoRA is loaded.

**Recommended settings:**
- Steps: 12 (more steps = better detail utilization)
- LoRA scale: 1.0 (default; try 0.5–0.8 for subtler effect)

## Usage

```bash
# With LoRA — short name resolution
python/venv/bin/python python/mlx-movie-director/run.py image t2i \
  --pipeline flux2-klein \
  --lora-path highresolutionflux2-kelien-9b \
  --prompt 'your prompt here' \
  --steps 12

# Adjust LoRA strength (0.0–1.0)
python/venv/bin/python python/mlx-movie-director/run.py image t2i \
  --pipeline flux2-klein \
  --lora-path highresolutionflux2-kelien-9b \
  --lora-scale 0.7 \
  --prompt 'your prompt here' \
  --steps 12

# A/B test: with vs without LoRA (generates review HTML)
# 1. Generate with LoRA
python/venv/bin/python python/mlx-movie-director/run.py image t2i \
  --pipeline flux2-klein \
  --lora-path highresolutionflux2-kelien-9b \
  --prompt 'your prompt' --steps 12 --seed 42
# 2. Generate without LoRA (same seed)
python/venv/bin/python python/mlx-movie-director/run.py image t2i \
  --pipeline flux2-klein \
  --prompt 'your prompt' --steps 12 --seed 42
# 3. Compare
python/venv/bin/python python/mlx-movie-director/run.py image review manifest \
  --last 2 --labels "With HighRes LoRA,Without LoRA"
```

## Test Prompt

```
a close-up portrait of a young woman with freckles and red hair, soft natural lighting, detailed skin texture, photorealistic, 8k uhd
```

Use this prompt with `--seed 42 --steps 12` to reproduce a reference output for
comparing LoRA effect.
