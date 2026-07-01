# luciddreamer-z — ZImage-Turbo Transformer (8-bit MLX)

LucidDreamer Z v0.777A ZiT: Hyper-detailed, surreal, dreamlike image generator with cinematic lighting and imaginative surrealism.

Source: [https://civitai.com/models/2229037](https://civitai.com/models/2229037)

## Best For

- Fantasy and dreamlike scenes with ethereal, surreal atmosphere
- Flowing, magical environments (glowing forests, mystical landscapes)
- Portraits with soft, otherworldly lighting and hyper-detailed textures
- Lucid / surrealist art direction where mood matters more than photorealism

**Not ideal for**: strict photorealism, urban/street scenes, or documentary-style images.

## Sample Prompts

```
a stunning young woman, half body, fantasy dreamlike setting, flowing ethereal dress,
magical glowing forest, surreal atmosphere, hyper detailed, lucid dreamlike quality
```

```
ancient wizard floating above misty mountains, robes shimmering with starlight,
surreal dreamscape, glowing runes, hyper detailed, ethereal cinematic lighting
```

## Usage

```bash
python/venv/bin/python python/mlx-movie-director/run.py \
  image t2i --pipeline zimage --transformer luciddreamer-z \
  --prompt 'your prompt here' \
  --width 768 --height 1024 --steps 20 --cfg-scale 4.5 --seed 777
```

## Notes

- Format: 8-bit quantized MLX (group_size=64)
- Converted from CivitAI bf16 safetensors via `import-checkpoint`
- Compatible with: text_encoder/qwen3-4b, tokenizer/qwen3, vae/zimage-ae
- Tested: `--steps 20 --cfg-scale 4.5` gives strong dreamlike quality
