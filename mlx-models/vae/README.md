# `models/vae/` — Variational Autoencoders

VAE models for latent↔pixel space conversion. Used during image generation (Phase 4 decode) and by the upscaler pipeline. Each sub-directory is one model instance.

## Directory structure

```
models/vae/
├── README.md                          ← this file
├── zimage-ae/                         ← ZImage-turbo AutoencoderKL (arch=flux-ae, 16ch, MLX BF16)
│   ├── config.json
│   ├── model.safetensors
│   ├── manifest.json
│   └── README.md
├── ultraflux-zimage-ae/               ← UltraFlux improved AutoencoderKL for zimage-turbo (same arch, MLX BF16)
│   ├── config.json
│   ├── model.safetensors
│   ├── manifest.json
│   └── README.md
├── flux2-klein/                       ← Flux2 Klein 9B VAE (AutoencoderKLFlux2, 32ch, MLX INT8) — NOT interchangeable with zimage-ae
│   ├── config.json
│   ├── model.safetensors
│   ├── manifest.json
│   └── README.md
├── ltx-2.3-vae/                       ← LTX-2.3 video VAE (safetensors BF16)
│   ├── config.json
│   ├── model.safetensors
│   ├── manifest.json
│   └── README.md
├── seedvr2-vae/                       ← SeedVR2 3D VAE (MLX BF16)
│   ├── config.json
│   ├── model.safetensors
│   ├── manifest.json
│   └── README.md
└── seedvr2-vae-int8/                  ← SeedVR2 3D VAE INT8 quantized (MLX INT8)
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
  "type": "vae",
  "arch": "<architecture-id>",
  "format": "<pytorch-fp32 | mlx-bf16 | ...>",
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
| `type` | string | ✅ | Always `"vae"` for this category |
| `arch` | string | ✅ | Architecture identifier (e.g. `flux-ae`, `seedvr2-vae`) |
| `format` | string | ✅ | Weight format: `pytorch-fp32`, `mlx-bf16`, etc. |
| `description` | string | ✅ | Human-readable summary |
| `compatible_with` | string[] | ✅ | Transformer or pipeline names this VAE works with |
| `size_bytes` | integer | ✅ | File size of the weight file in bytes |
| `created_at` | string | ✅ | ISO-8601 timestamp of download/conversion |

### Required files per instance

| File | Required | Notes |
|------|----------|-------|
| Weight file | ✅ | `model.safetensors` (MLX) or `diffusion_pytorch_model.safetensors` (PyTorch) |
| `config.json` | ✅ | Architecture config (latent_channels, scaling_factor, etc.) |
| `manifest.json` | ✅ | Metadata following schema above |
| `README.md` | ✅ | Source, download/conversion steps, runtime usage |

## Adding a new VAE

1. Create a new sub-directory: `models/vae/<instance-name>/`
2. Download or convert the model weights
3. Create `config.json` with architecture parameters
4. Create `manifest.json` matching the schema above
5. Create `README.md` documenting source, download/conversion, and runtime usage
6. Update `app/config.py` to point to the new directory
