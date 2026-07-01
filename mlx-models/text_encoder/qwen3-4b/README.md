# Text Encoder (Qwen3-4B — 4-bit MLX)

Qwen3-4B text encoder converted to MLX and quantized to 4-bit (group_size=32). Encodes text prompts into embeddings for the Z-Image transformer.

## Files

| File | Size | Needed at runtime |
|------|------|-------------------|
| `config.json` | ~0.3 KB | ✅ Yes — model architecture config |
| `model.safetensors` | ~2.3 GB | ✅ Yes — 4-bit quantized MLX weights |

## Source

Converted from the ComfyUI-compatible checkpoint:

```
comfyui_data/models/text_encoders/qwen_3_4b.safetensors   (~7.5 GB, PyTorch FP16)
```

## How to reproduce

```bash
# Requires source model at comfyui_data/models/text_encoders/qwen_3_4b.safetensors
./python/venv/bin/python python/mlx-movie-director/convert.py --text-encoder
```

### Conversion steps

1. Load `qwen_3_4b.safetensors` via `safetensors.torch.load_file` (~7.5 GB in RAM)
2. Cast all weights to bfloat16 numpy → MLX `mx.array`
3. Load into `TextEncoderMLX` model (Qwen3 architecture: 36 layers, 2560 hidden, GQA with 8 KV heads)
4. Quantize to 4-bit with `mlx.nn.quantize(model, bits=4, group_size=32)`
5. Save as `model.safetensors` + `config.json`

**Result**: ~7.5 GB → ~2.3 GB (3.3× compression), negligible quality loss.

## Architecture config

| Parameter | Value |
|-----------|-------|
| hidden_size | 2560 |
| intermediate_size | 9728 |
| num_attention_heads | 32 |
| num_key_value_heads | 8 (GQA) |
| num_hidden_layers | 36 |
| head_dim | 128 |
| rope_theta | 1,000,000 |
| vocab_size | 151,936 |
