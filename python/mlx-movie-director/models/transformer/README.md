# `models/transformer/` — Diffusion Transformers

Core denoising transformer models (e.g. Z-Image, Flux). Each sub-directory is one model instance with its own weights and config.

## Directory structure

```
models/transformer/
├── README.md                     ← this file
├── zimage-moody-v126/            ← Z-Image Moody V12.6 DPO (4-bit MLX)
│   ├── config.json
│   ├── model.safetensors
│   ├── manifest.json
│   └── README.md
└── seedvr2-7b/                   ← SeedVR2 7B upscaler DiT (4-bit MLX)
    ├── config.json
    ├── model.safetensors
    ├── manifest.json
    └── README.md
```

## Manifest schema

Each instance **must** have a `manifest.json` with this schema:

```json
{
  "name": "<instance-name>",
  "type": "transformer",
  "arch": "<architecture-id>",
  "format": "<mlx-4bit-gs32 | mlx-bf16 | pytorch-fp16 | ...>",
  "description": "One-line human-readable description",
  "compatible_with": ["<pipeline-or-vae-names>"],
  "size_bytes": 0,
  "created_at": "ISO-8601"
}
```

### Field definitions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✅ | Must match the sub-directory name |
| `type` | string | ✅ | Always `"transformer"` for this category |
| `arch` | string | ✅ | Architecture identifier (e.g. `zimage-turbo`, `flux2-klein`) |
| `format` | string | ✅ | Weight format: `mlx-4bit-gs32`, `mlx-bf16`, etc. |
| `description` | string | ✅ | Human-readable summary |
| `compatible_with` | string[] | ✅ | Pipeline or VAE names this transformer works with |
| `size_bytes` | integer | ✅ | File size of `model.safetensors` in bytes |
| `created_at` | string | ✅ | ISO-8601 timestamp of conversion |

### Required files per instance

| File | Required | Notes |
|------|----------|-------|
| `model.safetensors` | ✅ | MLX weights (quantized or BF16) |
| `config.json` | ✅ | Architecture config (dims, layers, heads, etc.) |
| `manifest.json` | ✅ | Metadata following schema above |
| `README.md` | ✅ | Source, conversion steps, architecture config |

## Adding a new transformer

1. Create a new sub-directory: `models/transformer/<instance-name>/`
2. Convert the source model and place `model.safetensors` inside
3. Create `config.json` with architecture parameters
4. Create `manifest.json` matching the schema above
5. Create `README.md` documenting source, conversion, and config
6. Update `app/config.py` to point to the new directory
7. Add a `--<instance>` flag to `convert.py` if the model needs conversion
