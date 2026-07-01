# `models/` — Local Model Directory

All model weights and configs for mlx-movie-director live here, organized by component type.

## Weight storage (externalized — weights are NOT in the repo)

The `.safetensors` entries under `models/` are **symlinks**, not real weight
files. Real weights live in a content-addressed store outside the repo:

- **Store:** `../video_generation__models/<md5>.safetensors` (~135 GB, shared
  across sibling worktrees with zero copy). Never committed.
- **In-tree:** model dirs hold symlinks into the store (or into category dirs
  under `models/`), so `mflux` / `ltx-2-mlx` loaders resolve them by relative
  path.
- `*.safetensors` is ignored in `python/.gitignore` as a safety net so real
  weights can never be accidentally committed. To track a symlink that *must*
  be checked in, force-add it (`git add -f path/to/model.safetensors`); it is
  stored as a tiny mode-120000 symlink (the path string), never the weight
  bytes. `gitignore` does not untrack already-tracked files.
- Flat assembly dirs `ltx-mlx/{dev,distilled}` are build artifacts (ignored
  via `ltx-mlx/.gitignore`); recreate them locally from the store.

> The layout / validation sections below describe the *logical* model catalog
> (manifests + READMEs, which ARE committed). Weight files referenced there
> are the externalized symlinks above.

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
