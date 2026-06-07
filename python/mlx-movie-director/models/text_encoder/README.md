# `models/text_encoder/` — Text Encoders

Text encoder models that convert text prompts into embeddings for diffusion transformers (e.g. Qwen3-4B). Each sub-directory is one model instance.

## Directory structure

```
models/text_encoder/
├── README.md                     ← this file
└── qwen3-4b/                     ← Qwen3-4B (4-bit MLX)
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
  "type": "text_encoder",
  "arch": "<architecture-id>",
  "format": "<mlx-4bit-gs32 | mlx-bf16 | ...>",
  "description": "One-line human-readable description",
  "compatible_with": ["<transformer-or-pipeline-names>"],
  "size_bytes": 0,
  "created_at": "ISO-8601"
}
```

### Field definitions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✅ | Must match the sub-directory name |
| `type` | string | ✅ | Always `"text_encoder"` for this category |
| `arch` | string | ✅ | Architecture identifier (e.g. `zimage`, `flux2-klein`) |
| `format` | string | ✅ | Weight format: `mlx-4bit-gs32`, `mlx-bf16`, etc. |
| `description` | string | ✅ | Human-readable summary |
| `compatible_with` | string[] | ✅ | Transformer or pipeline names this encoder works with |
| `size_bytes` | integer | ✅ | File size of `model.safetensors` in bytes |
| `created_at` | string | ✅ | ISO-8601 timestamp of conversion |

### Required files per instance

| File | Required | Notes |
|------|----------|-------|
| `model.safetensors` | ✅ | MLX weights (quantized or BF16) |
| `config.json` | ✅ | Architecture config (hidden_size, layers, heads, etc.) |
| `manifest.json` | ✅ | Metadata following schema above |
| `README.md` | ✅ | Source, conversion steps, architecture config |

## Adding a new text encoder

1. Create a new sub-directory: `models/text_encoder/<instance-name>/`
2. Convert the source model and place `model.safetensors` inside
3. Create `config.json` with architecture parameters
4. Create `manifest.json` matching the schema above
5. Create `README.md` documenting source, conversion, and config
6. Update `app/config.py` to point to the new directory
7. Add a `--<instance>` flag to `convert.py` if the model needs conversion
