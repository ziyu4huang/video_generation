# `models/lora/` — LoRA Adapters

Low-rank adapters overlaid on diffusion transformers at runtime (no pre-conversion needed). Each sub-directory is one adapter instance.

## Directory structure

```
models/lora/
├── README.md                     ← this file
└── zit-sda-v1/                   ← ZImage Style Diversity Adapter v1 (FP32 safetensors)
    ├── zit_sda_v1.safetensors
    ├── manifest.json
    └── README.md
```

## Manifest schema

Each instance **must** have a `manifest.json` with this schema:

```json
{
  "name": "<instance-name>",
  "type": "lora",
  "arch": "<architecture-id>",
  "format": "<safetensors-fp32 | safetensors-fp16 | ...>",
  "description": "One-line human-readable description",
  "compatible_with": ["<transformer-names>"],
  "size_bytes": 0,
  "created_at": "ISO-8601"
}
```

### Field definitions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✅ | Must match the sub-directory name |
| `type` | string | ✅ | Always `"lora"` for this category |
| `arch` | string | ✅ | Architecture identifier (e.g. `zimage-turbo`, `flux2-klein`) |
| `format` | string | ✅ | Weight format: `safetensors-fp32`, `safetensors-fp16`, etc. |
| `description` | string | ✅ | Human-readable summary |
| `compatible_with` | string[] | ✅ | Transformer names this adapter works with |
| `size_bytes` | integer | ✅ | File size of the weight file in bytes |
| `created_at` | string | ✅ | ISO-8601 timestamp of download |

### Required files per instance

| File | Required | Notes |
|------|----------|-------|
| Weight file | ✅ | `.safetensors` (FP32 or FP16 — converted on-the-fly at runtime) |
| `manifest.json` | ✅ | Metadata following schema above |
| `README.md` | ✅ | Source, usage, and compatibility notes |

## Adding a new LoRA

1. Create a new sub-directory: `models/lora/<instance-name>/`
2. Copy the `.safetensors` file inside
3. Create `manifest.json` matching the schema above
4. Create `README.md` documenting source and usage
5. Use via `--lora-path models/lora/<instance-name>/<file>.safetensors`

## Why no MLX conversion?

LoRA files are converted on-the-fly at runtime (PyTorch → numpy → MLX bfloat16, in memory). This is fast (~1s for 162MB) because LoRA weights are low-rank A/B matrices — small compared to the base model, and no quantization benefit.
