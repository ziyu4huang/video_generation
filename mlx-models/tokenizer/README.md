# `models/tokenizer/` — Tokenizers

BPE/tokenizer models used by text encoder pipelines. Each sub-directory is one tokenizer instance, typically downloaded from HuggingFace.

## Directory structure

```
models/tokenizer/
├── README.md                     ← this file
└── qwen3/                        ← Qwen3 BPE fast tokenizer
    ├── manifest.json
    ├── tokenizer.json
    ├── tokenizer_config.json
    ├── tmp/                       ← conversion artifacts (safe to delete)
    │   ├── merges.txt            ← (slow tokenizer fallback, not used at runtime)
    │   └── vocab.json            ← (slow tokenizer fallback, not used at runtime)
    └── README.md
```

## Manifest schema

Each instance **must** have a `manifest.json` with this schema:

```json
{
  "name": "<instance-name>",
  "type": "tokenizer",
  "arch": "<architecture-id>",
  "format": "hf-tokenizer",
  "description": "One-line human-readable description",
  "compatible_with": ["<text-encoder-or-pipeline-names>"],
  "size_bytes": 0,
  "created_at": "ISO-8601"
}
```

### Field definitions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✅ | Must match the sub-directory name |
| `type` | string | ✅ | Always `"tokenizer"` for this category |
| `arch` | string | ✅ | Architecture identifier (e.g. `qwen3`, `t5`) |
| `format` | string | ✅ | Always `"hf-tokenizer"` for HuggingFace tokenizers |
| `description` | string | ✅ | Human-readable summary |
| `compatible_with` | string[] | ✅ | Text encoder or pipeline names this tokenizer works with |
| `size_bytes` | integer | ✅ | File size of `tokenizer.json` in bytes |
| `created_at` | string | ✅ | ISO-8601 timestamp of download |

### Required files per instance

| File | Required | Notes |
|------|----------|-------|
| `tokenizer.json` | ✅ | Fast tokenizer (vocab + merges pre-compiled) |
| `tokenizer_config.json` | ✅ | Chat template, special tokens, config |
| `manifest.json` | ✅ | Metadata following schema above |
| `README.md` | ✅ | Source, download steps, runtime usage |

## Adding a new tokenizer

1. Create a new sub-directory: `models/tokenizer/<instance-name>/`
2. Download from HuggingFace or copy tokenizer files
3. Create `manifest.json` matching the schema above
4. Create `README.md` documenting source and runtime usage
5. Update `app/config.py` to point to the new directory

## `tmp/` convention

Files placed in a `tmp/` subfolder are **conversion or download artifacts** that are not needed at runtime. They can be safely deleted to reclaim disk space. The `check-manifests` command reports `tmp/` folders as cleanup candidates.
