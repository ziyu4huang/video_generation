# text_encoder/qwen3-8b — Qwen3 8B Text Encoder (INT8)

## Source

Converted from `black-forest-labs/FLUX.2-klein-9B/text_encoder/` (BF16 ~15.3 GB)
via `convert.py --klein-9b` using mflux `ModelSaver`.

## Files

| File | Size | Description |
|------|------|-------------|
| config.json | ~0.5 KB | Qwen3ForCausalLM architecture config |
| generation_config.json | ~0.2 KB | Generation parameters |
| 0.safetensors | 2.0 GB | INT8 quantized shard 0 |
| 1.safetensors | 2.0 GB | INT8 quantized shard 1 |
| 2.safetensors | 2.0 GB | INT8 quantized shard 2 |
| 3.safetensors | 1.6 GB | INT8 quantized shard 3 |
| model.safetensors.index.json | ~1 KB | Shard key → file mapping |

**Total: ~7.7 GB** (BF16 ~15.3 GB → INT8 ~7.7 GB, 50% reduction)

## Key Config

| Param | Value |
|-------|-------|
| architectures | ["Qwen3ForCausalLM"] |
| hidden_size | 4096 |
| intermediate_size | 12288 |
| num_hidden_layers | 36 |
| num_attention_heads | 32 |
| num_key_value_heads | 8 (GQA) |
| vocab_size | 151,936 |

## Used by

- `run.py profile` — encodes prompts + reference descriptions for Klein 9B
- `app/flux2_pipeline.py` → assembled via symlink with transformer, vae, tokenizer

## Reproduce

```bash
/Users/huangziyu/.local/bin/python3.13 convert.py --klein-9b
```
