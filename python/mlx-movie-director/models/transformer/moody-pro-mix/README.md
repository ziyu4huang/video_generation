# moody-pro-mix — ZImage-Turbo Transformer (8-bit MLX)

Moody Pro Mix ZIT V13: Advanced ZImageTurbo checkpoint for expressive, emotionally rich, and stylistically diverse image generation.

Source: [https://civitai.com/models/620406](https://civitai.com/models/620406)

## Best For

- Photorealistic portraits with cinematic lighting (golden hour, studio, natural)
- Street and urban photography style — fashion, lifestyle, editorial
- Full-body and half-body shots with strong detail in skin, hair, and clothing
- Emotionally expressive scenes where mood and atmosphere carry the image

**Not ideal for**: abstract surrealism, anime/comic styles, or flat cel-shaded art.

## Sample Prompts

```
a beautiful young woman, full body shot, standing on a city street,
wearing chic casual fashion, long dark hair, golden hour sunlight,
photorealistic, ultra sharp, 8k
```

```
male photographer, candid moment, Tokyo alley, rain-slicked cobblestones,
neon reflections, cinematic depth of field, photorealistic, moody lighting
```

## Usage

```bash
python/venv/bin/python python/mlx-movie-director/run.py \
  image t2i --pipeline zimage --transformer moody-pro-mix \
  --prompt 'your prompt here' \
  --width 768 --height 1024 --steps 20 --cfg-scale 4.5 --seed 777
```

## Notes

- Format: 8-bit quantized MLX (group_size=64)
- Converted from CivitAI bf16 safetensors via `import-checkpoint`
- Compatible with: text_encoder/qwen3-4b, tokenizer/qwen3, vae/zimage-ae
- Tested: `--steps 20 --cfg-scale 4.5` balances sharpness and realism well
