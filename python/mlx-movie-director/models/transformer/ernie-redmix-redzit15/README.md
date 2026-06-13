# ernie-redmix-redzit15

ZImage Turbo finetune, 4-bit MLX.

- **Source**: CivitAI [958009/2462789](https://civitai.com/models/958009?modelVersionId=2462789) (baseModel ZImageTurbo)
- **Converted**: `convert.py --zit-checkpoint ernie-redmix-redzit15_bf16_pruned.safetensors`
- **Size**: 3.8 GB
- **Quantization**: 4-bit, group_size=32
- **Sampler**: EULER/DEIS | Simple | CFG=1 | 10 Steps

Shares text encoder (qwen3-4b), tokenizer (qwen3), and VAE (flux-ae) with the built-in ZImage models.
