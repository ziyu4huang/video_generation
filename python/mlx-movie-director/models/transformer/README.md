# `models/transformer/` — Diffusion Transformers

Core denoising transformer models (e.g. Z-Image, Flux). Each sub-directory is one model instance with its own weights and config.

## Model inventory

### Z-Image / zimage-turbo (`--pipeline zimage`)

| Directory | CLI command | Notes |
|-----------|-------------|-------|
| `zimage-moody-v126/` | `image t2i --pipeline zimage` | Default — no `--transformer` needed |
| `dark-beast-dbzit9/` | `image t2i --pipeline zimage --transformer dark-beast-dbzit9` | Dark Beast ZIT9 DIMR finetune |
| `ernie-redmix-redzit15/` | `image t2i --pipeline zimage --transformer ernie-redmix-redzit15` | Ernie Redmix ZIT15 finetune |

### Flux2 Klein (`--pipeline flux2-klein`)

| Directory | CLI command | Notes |
|-----------|-------------|-------|
| `klein-9b/` | `image t2i --pipeline flux2-klein` | Default 9B — no `--transformer` needed |
| `klein-9b-dark-beast-bfs/` | `image t2i --pipeline flux2-klein --transformer klein-9b-dark-beast-bfs` | Face-swap specialized variant |

### LTX-2.3 video (`video generate`)

| Directory | CLI command | Notes |
|-----------|-------------|-------|
| `ltx-2.3-dev-q8/` | `video generate --transformer dev` | Default — `--transformer dev` can be omitted |
| `ltx-2.3-distilled-q8/` | `video generate --transformer distilled` | Shorthand: `--distilled` flag |
| `ltx-2.3-dasiwa-golden-lace-v3-q8/` | `video generate --transformer dasiwa` | DaSiWa Golden Lace V3 finetune |

### SeedVR2 upscaler

| Directory | CLI command | Notes |
|-----------|-------------|-------|
| `seedvr2-7b/` | `image purify` | Also: `upscale`, `image expansion --upscale-method seedvr2` |

---

## Directory structure

Each sub-directory follows this layout:

```
models/transformer/<instance-name>/
├── model.safetensors   ← MLX weights (quantized or BF16)
├── config.json         ← architecture config (dims, layers, heads, etc.)
├── manifest.json       ← metadata (schema below)
└── README.md           ← source, conversion steps, architecture notes
```

## Manifest schema

Each instance **must** have a `manifest.json`. The `cli` field documents the exact run.py invocation — this is the canonical mapping between `pipeline` (internal arch name) and `--pipeline` (CLI flag).

```json
{
  "name": "<instance-name>",
  "type": "transformer",
  "arch": "<architecture-id>",
  "format": "<mlx-4bit-gs32 | mlx-int8 | mlx-bf16 | ...>",
  "description": "One-line human-readable description",
  "pipeline": ["<internal-arch-name>"],
  "cli": {
    "action": "image t2i | video generate | image purify | upscale",
    "pipeline": "<--pipeline flag value>",
    "transformer": "<--transformer flag value — omit if default>",
    "note": "optional clarification"
  },
  "compatible_with": ["<component/name>"],
  "size_bytes": 0,
  "created_at": "ISO-8601"
}
```

### Why `pipeline` ≠ `--pipeline`

The `pipeline` field uses internal architecture IDs (e.g. `"zimage-turbo"`, `"flux2-klein-9b"`).
The CLI `--pipeline` flag uses shorter aliases (`"zimage"`, `"flux2-klein"`).
The `cli` object bridges the gap — read it to know exactly what to type.

### Field definitions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✅ | Must match the sub-directory name |
| `type` | string | ✅ | Always `"transformer"` for this category |
| `arch` | string | ✅ | Architecture identifier (e.g. `zimage-turbo`, `flux2-klein-9b`) |
| `format` | string | ✅ | Weight format: `mlx-4bit-gs32`, `mlx-int8`, `mlx-bf16`, etc. |
| `description` | string | ✅ | Human-readable summary |
| `pipeline` | string[] | ✅ | Internal pipeline IDs this transformer belongs to |
| `cli` | object | ✅ | Exact `run.py` CLI invocation (see schema above) |
| `compatible_with` | string[] | ✅ | Component dependencies (text encoder, VAE, tokenizer) |
| `size_bytes` | integer | ✅ | File size of `model.safetensors` in bytes |
| `created_at` | string | ✅ | ISO-8601 timestamp of conversion |

## Adding a new transformer

1. Create a new sub-directory: `models/transformer/<instance-name>/`
2. Convert the source model and place `model.safetensors` inside
3. Create `config.json` with architecture parameters
4. Create `manifest.json` — include the `cli` field so the mapping is clear
5. Create `README.md` documenting source, conversion, and config
6. Update the inventory table above
7. Update `app/config.py` to point to the new directory
8. Add a `--<instance>` flag to `convert.py` if the model needs conversion
