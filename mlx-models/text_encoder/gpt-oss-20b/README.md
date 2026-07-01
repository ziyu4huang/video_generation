# Text Encoder (GPT-OSS-20B for Microsoft Lens — MLX INT4)

OpenAI GPT-OSS-20B text encoder for the Microsoft Lens 3.8B MMDiT pipeline. MoE
feed-forward with 64/8 grouped-query attention, YARN RoPE, and a 128-token
sliding window. Lens loads multi-layer hidden states at selected layers
(5, 11, 17, 23) as the conditioning signal.

Converted from a ComfyUI-managed NVFP4 checkpoint and re-quantized to MLX INT4
(group_size=32).

## Files

| File | Size | Needed at runtime |
|------|------|-------------------|
| `config.json` | ~0.5 KB | ✅ Yes — model architecture config |
| `model.safetensors` | ~13.5 GB | ✅ Yes — INT4 quantized MLX weights |
| `tokenizer.json` | ~27.8 MB | ✅ Yes — GPT-OSS tokenizer (same as GPT-4o) |

> Both weight files are gitignored (`*.safetensors` by the root rule,
> `tokenizer.json` by the `models/**/tokenizer.json` rule) — re-obtain them via
> the commands below or the `files[]` entries in `manifest.json`.

## Source

```
comfyui_data/models/text_encoders/gpt_oss_20b_nvfp4.safetensors   (~13 GB, NVFP4)
```

The NVFP4 source is a ComfyUI-managed download (ComfyUI-Manager → text_encoders
section) — not a direct HuggingFace fetch. If absent, search HuggingFace for a
`gpt-oss-20b` NVFP4 checkpoint.

## How to reproduce

```bash
# Requires the NVFP4 source at comfyui_data/models/text_encoders/gpt_oss_20b_nvfp4.safetensors
python/venv/bin/python python/mlx-movie-director/scripts/convert_lens_te_mlx.py \
  --src comfyui_data/models/text_encoders/gpt_oss_20b_nvfp4.safetensors \
  --dst python/mlx-movie-director/models/text_encoder/gpt-oss-20b \
  --bits 4

# Tokenizer (separate download from HuggingFace)
huggingface-cli download openai/gpt-oss-20b tokenizer.json \
  --local-dir python/mlx-movie-director/models/text_encoder/gpt-oss-20b
```

### Conversion steps

1. Load the NVFP4 `.safetensors` on CPU (comfy_kitchen eager backend, CUDA-free)
2. Dequantize NVFP4 → BF16 layer-by-layer (avoids a ~40 GB RAM peak)
3. Split the 3D MoE expert banks `[E, O, I]` → per-expert 2D arrays `[O, I]`
4. Apply MLX INT4 quantization (group_size=32) → ~12 GB output

**Result**: NVFP4 ~13 GB → MLX INT4 ~13.5 GB (re-quantized to the MLX native
format Lens consumes).

## Architecture config

| Parameter | Value |
|-----------|-------|
| hidden_size | 2880 |
| num_hidden_layers | 24 |
| num_attention_heads | 64 |
| num_key_value_heads | 8 |
| head_dim | 64 |
| vocab_size | 201088 |
| num_experts | 32 |
| sliding_window | 128 |
| hidden-state output layers | 5, 11, 17, 23 |
| RoPE | YARN |

> Dims above were extracted directly from the NVFP4 safetensors header (the Lens
> text-encoder variant), not the upstream `openai/gpt-oss-20b` config.
