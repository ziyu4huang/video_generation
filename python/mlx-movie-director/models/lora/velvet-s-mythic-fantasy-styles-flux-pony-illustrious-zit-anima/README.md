# velvet-s-mythic-fantasy-styles-flux-pony-illustrious-zit-anima — LoRA Adapter (zimage-turbo)

Velvet's Mythic Fantasy Styles | Flux + Pony + illustrious + ZiT + Anima ZiT Gothic Lines.

Source: [https://civitai.com/models/599757](https://civitai.com/models/599757)

## Files

| File | Size | Description |
|------|------|-------------|
| `ZiTMythG0thicL1nes.safetensors` | ~162 MB | LoRA weights (zimage-turbo) |

## Trigger Words

`G0thicL1nes`, `MythAn1m3`, `MythP0rt`

**Recommended scale:** `0.6`

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/velvet-s-mythic-fantasy-styles-flux-pony-illustrious-zit-anima/ZiTMythG0thicL1nes.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/velvet-s-mythic-fantasy-styles-flux-pony-illustrious-zit-anima/ZiTMythG0thicL1nes.safetensors \
  --lora-scale 0.6
```

## Test Prompt

```
a fantasy portrait of a warrior with G0thicL1nes style, high detail, 8K
```
