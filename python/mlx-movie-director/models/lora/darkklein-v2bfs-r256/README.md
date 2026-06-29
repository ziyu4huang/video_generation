# darkklein-v2bfs-r256 — LoRA Adapter (flux2-klein-9b)

RedCraft Exported LoRAs DBKlein9b🟦 V2.0 LoRA.

Source: [https://civitai.com/models/964312](https://civitai.com/models/964312)

## Files

| File | Size | Description |
|------|------|-------------|
| `DarkKlein9b_v2BFS_extracted_lora_r256.safetensors` | ~1264 MB | LoRA weights (flux2-klein-9b) |

## Usage

```bash
# Apply LoRA with default scale 1.0
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/darkklein-v2bfs-r256/DarkKlein9b_v2BFS_extracted_lora_r256.safetensors

# Adjust scale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt 'your prompt here' \
  --lora-path python/mlx-movie-director/models/lora/darkklein-v2bfs-r256/DarkKlein9b_v2BFS_extracted_lora_r256.safetensors \
  --lora-scale 0.8
```
