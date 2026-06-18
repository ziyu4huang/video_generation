# dark-beast-dbzit9

ZImage Turbo finetune, 4-bit MLX.

- **Source**: CivitAI (https://civitai.com/models/2242173/dark-beast-or?modelVersionId=2788849) (baseModel ZImageTurbo)
- **Converted**: `convert.py --zit-checkpoint darkBeast_dbzit9DIMRclaw_fp8.safetensors`
- **Size**: 3.8 GB
- **Quantization**: 4-bit, group_size=32
- **Sampler**: EULER/DEIS | Simple | CFG=1 | 10 Steps

Shares text encoder (qwen3-4b), tokenizer (qwen3), and VAE (flux-ae) with the built-in ZImage models.
