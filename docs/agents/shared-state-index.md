# Shared State Index — Video Generation Monorepo

A cross-package index of **shared state**: configuration, resolution rules, and
environment conventions that are consumed by *more than one* package or command,
and that are easy to get wrong silently. This is the hand-written analogue of the
**state-register view ($\mathcal{Z}$)** from *Harness Handbook* (arXiv:2607.13285):
whereas per-package `CONTEXT.md` files are the L1–L2 behavior map ($\mathcal{D}$),
this file captures the cross-cutting state that ties those behaviors together.

> **Why this is a separate file.** The root `CONTEXT.md` is deliberately
> *definitions only — no implementation details (file paths, config keys, or code)*.
> Shared state is inherently implementation-level, so it lives here, not in the
> glossary. See `domain.md` for the `CONTEXT.md` convention this complements.

Each row's `_resolver` is a **verified-against-repo** locator (`file#symbol` or
script). If a symbol moves, the row must be refreshed — same behavior–implementation
alignment discipline as the `_Source_:` anchors in per-package `CONTEXT.md`.

## Index

| State | Resolver / source | Consumers | Drift risk |
|-------|-------------------|-----------|------------|
| **Active vault root** | `bun-apps/s2-agent-ext-research-tool/lib/vault.ts#resolveVaultRoot` — tiers: `OB_VAULT_PATH` env (1a) → `run-dir/obsidian_config.json` `vault_path` when mode≠app (1b) → `<cwd>/.pi/obsidian_config.json` `vault_path` legacy (1c) → `<cwd>` fallback | all `s2-agent-ext-research-tool` tools: `collect_videos`, `arxiv_fetch2md`, `organize_vault_notes` (write targets `weekly-news/`, `papers/`) | `obsidian_config.json` absent **and** `OB_VAULT_PATH` unset → **silently** falls back to `<cwd>`; writes land in the repo instead of the intended vault. *(Incident: 2026-07-18, arxiv_fetch2md — had to pass explicit `output_path`.)* |
| **MLX models dir** | `python/mlx-movie-director/app/config.py#_resolve_models_dir` — `MLX_MODELS_DIR` env → `run.py --models-dir` flag → default `<cwd>/mlx-models`. External binary store at `../video_generation__models/` | every `run.py image` / `video` / `upscale` command | defaulting to `<cwd>/mlx-models` when neither env nor flag is set → model lookups fail or hit a stale local copy. Symlink/override the external store rather than duplicating weights. |
| **Python venv** | `python/venv/bin/python` — created by `scripts/setup-offline.sh` (fresh clone) or `uv venv python/venv --python 3.12 && uv pip install -r requirements.txt`. **Invoke from repo root only.** | all `python/mlx-movie-director` runs, all `pytest` | using system `python3` / `python3.13` instead → wrong/missing deps. ⚠️ **Currently absent** in this checkout (`python/venv` does not exist) — must be (re)created before any Python command works. |
| **Bun workspace root** | `bun-apps/bunfig.toml` (isolated linker + globalStore); canonical lockfile `bun-apps/bun.lock`. Add deps with `bun add` **inside `bun-apps/`**. | every `bun-apps/*` package install & test | running `bun install` from the **repo root** instead of `bun-apps/` → spawns a stray `package-lock.json` / divergent lockfile. Never commit `package-lock.json`. |
| **Sibling-fork deps** | `../mflux` (Z-Image), `../ltx-2-mlx` (LTX video) — installed by `scripts/setup-repo-deps.sh`; patched at runtime via `python/mlx-movie-director/app/vendor_patches.py#apply_all_patches` | Z-Image / Flux2 / LTX image & video generation | fresh clone without running `setup-repo-deps.sh` → MLX import errors. Never edit vendor submodules directly; add a `_patch_*()` and register in `apply_all_patches`. |

## Maintenance

- **When adding a tool/package that reads shared state**, add or update its row here.
- **When renaming/moving a resolver symbol**, update the `_resolver` cell the same
  day (treat it like the `_Source_:` anchors in `CONTEXT.md`).
- This index is **curated**, not auto-generated. If it grows beyond ~20 rows,
  consider whether some state is better captured as an ADR (`docs/adr/`) or a
  per-package `CONTEXT.md` entry instead.

## Related

- `domain.md` — the `CONTEXT.md` + ADR convention this cross-cutting view complements.
- Per-package `CONTEXT.md` files (e.g. `bun-apps/s2-agent-ext-research-tool/CONTEXT.md`) —
  the L1–L2 behavior map ($\mathcal{D}$); each entry now carries a `_Source_:` anchor.
- Design rationale: the paper analysis and "strengthening CONTEXT.md" design note
  live in the `study-news` vault (`content/paper-harness-handbook-analysis.md`,
  `content/strengthening-context-md-from-harness-handbook.md`).
