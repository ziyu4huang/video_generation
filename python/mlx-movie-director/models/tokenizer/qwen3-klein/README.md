# tokenizer/qwen3-klein — Qwen3 Tokenizer for Flux2 Klein 9B

## Source

From `black-forest-labs/FLUX.2-klein-9B/tokenizer/` (saved by mflux ModelSaver).

## Files

| File | Size | Description |
|------|------|-------------|
| tokenizer.json | ~11 MB | Fast tokenizer (BPE, vocab 151,936) |
| tokenizer_config.json | ~7 KB | Tokenizer configuration |
| added_tokens.json | ~1 KB | Special tokens |
| special_tokens_map.json | ~0.3 KB | Special token definitions |
| chat_template.jinja | ~0.3 KB | Chat template (`<\|im_start\|>...<\|im_end\|>`) |
| tmp/vocab.json | ~2 MB | Slow tokenizer fallback (safe to delete) |

**Total: ~11 MB**

## Used by

- `run.py profile` — tokenizes prompts for Klein 9B text encoder
- `app/flux2_pipeline.py` → assembled via symlink with transformer, text_encoder, vae

## Reproduce

```bash
/Users/huangziyu/.local/bin/python3.13 convert.py --klein-9b
```
