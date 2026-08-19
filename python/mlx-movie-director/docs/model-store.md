# Model weight store (content-addressed, worktree-shared)

The MLX model weights under `python/mlx-movie-director/models/` (~133GB of
`.safetensors`) are gitignored, so they don't travel with git. Instead each weight
lives once in a **content-addressed store** that is a sibling of the repo, and the
in-tree path is a **relative symlink** into it. Because the store is a sibling of
the repo, the same relative symlink resolves identically from the main repo and
from any **sibling** worktree — so a fresh worktree uses the models with zero
copying.

```
/Users/huangziyu/proj/
├── video_generation/                     ← main repo (weights are symlinks)
├── video_generation_try1/                ← sibling worktree (same symlinks → same store)
└── video_generation__models/             ← shared store (<md5>.safetensors blobs)
```

Symlinks are committed (`git add -f`, overriding the `*.safetensors` ignore) so a
worktree gets them on checkout. Loaders are symlink-transparent (`mx.load`,
safetensors), and the repo already relied on this (the `ltx-mlx/` assembly links).

## One-time setup (after cloning or creating a worktree)

The store must exist and be populated once per machine. From a worktree whose
weights are still real files:

```bash
python/venv/bin/python scripts/externalize_models.py --dry-run   # preview (hashes everything)
python/venv/bin/python scripts/externalize_models.py --apply     # move blobs to store, symlink in place
```

For a NEW worktree on a machine where the store already exists, the committed
symlinks already point at it — nothing to run (sibling worktrees). For a **nested**
worktree (e.g. `.claude/worktrees/X/`) the committed relative links are the wrong
depth; one run fixes them:

```bash
python/venv/bin/python scripts/externalize_models.py --apply     # relinks to the right depth
```

## Recovery (lost symlinks)

`--apply` writes a committed manifest at `python/mlx-movie-director/models/store-manifest.json`
mapping every weight path → its md5. If symlinks are ever lost (accidental `rm`,
a checkout that dropped them, a fresh clone), rebuild them all from the manifest —
no original link needs to survive, only the store blobs:

```bash
python/venv/bin/python scripts/externalize_models.py --relink     # recreate every symlink from the manifest
```

So recovery works two ways: the committed symlinks come back on a normal checkout,
and `--relink` regenerates them from the manifest if they're gone. (`--relink` will
not clobber a path that is currently a real file — it warns and skips.)

## Adding a new model

1. Drop the `.safetensors` file into its model dir (metadata `config.json` /
   `manifest.json` are committed as usual).
2. `python/venv/bin/python scripts/externalize_models.py --apply` — moves the new
   blob into the store (dedups if identical to an existing one) and creates the link.
3. `git add -f <path/to/new.safetensors>` then commit (the symlink).

## Restore (reverse)

Replace every store-symlink with the real file copied back from the store (store
left intact):

```bash
python/venv/bin/python scripts/externalize_models.py --restore
```

## Notes

- Store path default: `<repo>/../video_generation__models` (override with `--store`).
- Content-addressed by md5 → identical weights are stored once (dedup). The store's
  `INDEX.txt` maps each hash to the path(s) that reference it.
- `--min-size N` externalizes only weights ≥ N bytes (default 0 = all `.safetensors`).
- The `ltx-mlx/{distilled,dev,dasiwa}/` dirs are a **gitignored, regeneratable
  symlink-forest aggregator** (not committed). They gather the scattered LTX files into
  one flat load dir and are recreated by `scripts/setup_ltx_symlinks.py` (or auto-assembled
  by `ltx_pipeline._assemble_flat_dir()` at runtime). The externalize script leaves them
  untouched; once the real model files they point at are externalized, a regenerated
  `ltx-mlx/` resolves through to the store. Do NOT `git add -f` these — they're meant to be
  local-only.
