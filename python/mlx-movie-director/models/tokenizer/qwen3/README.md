# Tokenizer (Qwen2.5 / Z-Image Turbo)

Qwen2.5 BPE tokenizer used by the Z-Image text encoder pipeline.

## Files

| File | Size | Needed at runtime |
|------|------|-------------------|
| `tokenizer.json` | ~11 MB | ✅ Yes — fast tokenizer (vocab + merges pre-compiled) |
| `tokenizer_config.json` | ~10 KB | ✅ Yes — chat template, special tokens, config |
| `tmp/merges.txt` | ~1.6 MB | ❌ No — slow tokenizer fallback, redundant with tokenizer.json |
| `tmp/vocab.json` | ~2.6 MB | ❌ No — slow tokenizer fallback, redundant with tokenizer.json |

## Source

Downloaded from [Tongyi-MAI/Z-Image-Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) (`tokenizer/` subdirectory).

## How to reproduce

```bash
./python/venv/bin/python python/mlx-movie-director/convert.py --tokenizer
```

This runs `huggingface_hub.snapshot_download` with `allow_patterns=["tokenizer/*"]`, placing files under `models/tokenizer/`.

## Runtime usage

```python
from transformers import AutoTokenizer
tokenizer = AutoTokenizer.from_pretrained("models/tokenizer", trust_remote_code=True)
```

Only `tokenizer.json` and `tokenizer_config.json` are loaded. The `tmp/` directory is not accessed.
