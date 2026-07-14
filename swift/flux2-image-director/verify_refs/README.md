# verify_refs/ — Swift-port golden references (NOT committed)

This directory holds the **golden reference tensors** that the `flux2 verify-*`
subcommands (`verify-vae`, `verify-encoder`/`verify-tokenizer`, `verify-transformer`,
`verify-e2e`, `verify-edit`) compare the Swift Flux2 port against, via cosine
similarity (pass threshold cos > 0.99). They prove the Swift implementation
matches the Python `mflux` reference stage-by-stage.

These files are **regenerable dev-only fixtures and are gitignored** — the
~130 MB of binaries is never committed (matching the repo's policy of
externalizing all model weights). Materialize them locally before running any
`verify-*` command.

## How to (re)generate

From the **repo root** (each script uses a fixed seed and a fixed output path,
so output is deterministic and matches the `--ref` defaults in the Verify commands):

```bash
python/venv/bin/python python/mlx-movie-director/app/tests/gen_flux2_vae_ref.py
python/venv/bin/python python/mlx-movie-director/app/tests/gen_flux2_encoder_ref.py
python/venv/bin/python python/mlx-movie-director/app/tests/gen_flux2_transformer_ref.py
python/venv/bin/python python/mlx-movie-director/app/tests/gen_flux2_e2e_ref.py
python/venv/bin/python python/mlx-movie-director/app/tests/gen_flux2_edit_ref.py
python/venv/bin/python python/mlx-movie-director/app/tests/gen_kontext_vae_ref.py
python/venv/bin/python python/mlx-movie-director/app/tests/gen_kontext_transformer_ref.py
python/venv/bin/python python/mlx-movie-director/app/tests/gen_kontext_clip_ref.py
python/venv/bin/python python/mlx-movie-director/app/tests/gen_kontext_t5_ref.py
python/venv/bin/python python/mlx-movie-director/app/tests/gen_kontext_tokenizer_ref.py
```

## Expected files

| File | Generator | Used by |
|---|---|---|
| `flux2_vae_ref.safetensors` | `gen_flux2_vae_ref.py` | `verify-vae` |
| `flux2_encoder_ref.safetensors` | `gen_flux2_encoder_ref.py` | `verify-encoder`, `verify-tokenizer` |
| `flux2_transformer_ref.safetensors` | `gen_flux2_transformer_ref.py` | `verify-transformer` |
| `flux2_e2e_latent_ref.safetensors` | `gen_flux2_e2e_ref.py` | `verify-e2e` |
| `flux2_edit_ref.safetensors` | `gen_flux2_edit_ref.py` | `verify-edit` |
| `ref_image.png` | `gen_flux2_edit_ref.py` | `verify-edit` (input image) |
| `kontext_vae_ref.safetensors` | `gen_kontext_vae_ref.py` | `verify-kontext-vae` |
| `kontext_transformer_ref.safetensors` | `gen_kontext_transformer_ref.py` | `verify-kontext-transformer` |
| `kontext_clip_ref.safetensors` | `gen_kontext_clip_ref.py` | `verify-kontext-clip` |
| `kontext_t5_ref.safetensors` | `gen_kontext_t5_ref.py` | `verify-kontext-t5` |
| `kontext_tokenizer_ref.json` | `gen_kontext_tokenizer_ref.py` | `verify-kontext-clip-tokenizer`, `verify-kontext-t5-tokenizer` |

`flux2_chat_formatted.txt` (small) is committed and used for tokenizer/format
parity checks.
