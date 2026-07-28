# verify_refs/ — Swift-port golden references (NOT committed)

This directory holds the **golden reference tensors** that the `musicgen
verify-*` subcommands compare the Swift MusicGen port against, via cosine
similarity (pass threshold cos > 0.99). They prove the Swift implementation
matches the real HF `transformers`/PyTorch reference stage-by-stage. Same
convention as `swift/flux2-image-director/verify_refs/README.md`.

These files are **regenerable dev-only fixtures and are gitignored** — raw
safetensors are never committed (matching the repo's policy of externalizing
all model weights). Materialize them locally before running any `verify-*`
command.

## How to (re)generate

From the **repo root**:

```bash
python/venv/bin/python python/mlx-movie-director/app/tests/gen_musicgen_t5_ref.py
python/venv/bin/python python/mlx-movie-director/app/tests/gen_musicgen_encodec_ref.py
python/venv/bin/python python/mlx-movie-director/app/tests/gen_musicgen_decoder_step_ref.py
```

## Expected files

| File | Generator | Used by |
|---|---|---|
| `musicgen_t5_ref.safetensors` | `gen_musicgen_t5_ref.py` | `verify-t5` |
| `musicgen_encodec_ref.safetensors` | `gen_musicgen_encodec_ref.py` | `verify-encodec` |
| `musicgen_decoder_step_ref.safetensors` | `gen_musicgen_decoder_step_ref.py` | `verify-decoder-step` |
