# `models/` — Local Model Directory

All model weights and configs for mlx-movie-director live here, organized by component type.

## Layout

```
models/
├── {category}/{instance}/manifest.json   — metadata for every model
├── {category}/{instance}/README.md       — source, conversion, config docs
└── {category}/{instance}/...             — weight files + configs
```

**Categories:** `transformer/`, `text_encoder/`, `vae/`, `tokenizer/`, `lora/`

## Every model instance MUST have

1. **`manifest.json`** — name, type, arch, format, description, size_bytes, compatible_with
2. **`README.md`** — human-readable docs describing **where the model came from** (source repo, conversion command, original format)
3. At least one weight file (`.safetensors`)

## Validation

```bash
/Users/huangziyu/.local/bin/python3.13 run.py check-manifests -v
```

This checks all manifests for: required fields, correct types, size matching, cross-references, and presence of README + weight files.

## Adding a new model

1. Run the appropriate conversion (e.g. `convert.py --klein-9b`)
2. Create `manifest.json` with accurate `size_bytes` (measure after conversion)
3. Create `README.md` documenting source, conversion command, and key config
4. Run `check-manifests -v` to verify
