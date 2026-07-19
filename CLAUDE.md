# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Video Generation — MLX on Apple Silicon

## Communication

- **Conversation language**: 繁體中文 (zh_TW) — use zh_TW for discussion, explanations, and Q&A
- **Written output**: English — all docs, code comments, commit messages, and file content in English

## Active stack

- **MLX pipeline** — `python/mlx-movie-director/run.py` (Z-Image / Flux2 Klein / Lens / LTX-2.3 / SeedVR2, all native MLX)
- **Bun GUI** — `bun-apps/gui-movie-director` (`bun run dev`; per-worktree port via `bun run gui:port`)

## Monorepo SOP

Bun workspace root is `bun-apps/` (isolated linker + globalStore via `bun-apps/bunfig.toml`); `bun-apps/bun.lock` is canonical. Run `bun install` from `bun-apps/`, never the repo root. Never commit `package-lock.json`. Add deps with `bun add` (inside `bun-apps/`).

## Python venv

```bash
python/venv/bin/python python/mlx-movie-director/run.py <args>
```
Invoke from repo root only. Never use system `python3` / `python3.13`. Setup via `bash scripts/setup-offline.sh` (fresh clone), or `uv venv python/venv --python 3.12 && uv pip install -r python/mlx-movie-director/requirements.txt`.

Sibling-fork deps: `../mflux` (Z-Image), `../ltx-2-mlx` (LTX video). Installed by `scripts/setup-repo-deps.sh`.

## Shell discipline

Never top-level `cd` — `no-cd-drift.sh` blocks it. Use `( cd <dir> && ... )`, `--cwd`/`-C`, or absolute paths.

## Platform

Apple Silicon MPS only. No CUDA attention (SDPA only). MLX dtypes: `bfloat16` native; quantize `mlx-8bit` (default) or 4-bit. No FP8.

## Startup

```bash
( cd bun-apps/gui-movie-director && bun run dev )
bun run --cwd bun-apps/gui-movie-director gui:port   # discover URL
```
Kill stuck server: `lsof -ti :<port> | xargs kill -9`. Fresh clone: `bash scripts/setup.sh`.

## run.py Subcommands

`python/venv/bin/python python/mlx-movie-director/run.py <cmd>`.

```
image [t2i|angle|review|profile|controlnet|i2i|faceswap|swap|anime2real|quality|workflow|expansion|purify|restore]
video [generate|review|compare|quality|restore|vbvr|relay|segment|t2i2v]
caption <image>   replay <manifest>   upscale   check-model
schema            schema-defaults
```

Self-test: `--self-test` or `--self-test t2i:portrait`. `--offline` for zero network egress.

## Testing

```bash
( cd bun-apps/<pkg> && bun test )                                        # any bun-apps/*
bun run --cwd bun-apps/gui-movie-director check:schema                  # validate vs run.py
( cd bun-apps/pi-agent-ext-workflow && bun run build && bun test )
python/venv/bin/python -m pytest python/mlx-movie-director/app/tests [--run-gpu]
```

## Key Directories

```
python/mlx-movie-director/    # ACTIVE — MLX pipeline
mlx-models/                   # MLX model tree (override: MLX_MODELS_DIR / --models-dir)
../video_generation__models/  # EXTERNAL binary store (outside repo)
bun-apps/gui-movie-director/  # ACTIVE — Bun + React GUI
```

## Extension packages (pi-agent-ext-*)

Every `bun-apps/pi-agent-ext-<X>/` registers its pi extension at **exactly one** canonical entry: `extensions/<X>.ts` (filename == folder suffix, no `pi-` prefix). One registered extension per folder.

- **Naming**: `extensions/<X>.ts` where `<X>` is the folder minus `pi-agent-ext-`. Never `src/index.ts`, root `index.ts`, `extensions/index.ts`, or `extensions/pi-<X>.ts` as the registration entry.
- **Lib entry stays separate**: if a package's lib `main` is `src/index.ts` (power-tool, hermes-memory) or root `index.ts` (web-access), add a 1-line re-export shim `export { default } from "../src/index.ts";` at `extensions/<X>.ts` as the registered entry — don't move the lib.
- **Registration**: dynamic extensions → `bun-apps/pi-agent/run-dir/manifest.json` (`extensions[]`); always-on/static → `bun-apps/pi-agent/src/static-extensions.ts`. Never list the same extension in both (double-register).
- **Schema-cost canary**: `bun-apps/pi-agent-cli/src/commands/schema-cost.ts` `discoverExtensionEntries()` derives its list from `bun-apps/pi-agent/run-dir/manifest.json` (`extensions[]` + `staticExtensions[]`) — extensions registered there are measured automatically. Only unregistered measure-worthy files need a manual `EXTRA_ENTRIES` row.
- **CLI subcommands**: extension-backed CLI subcommands live at `extensions/cli-subcommand.ts` and are wired in `bun-apps/pi-agent-cli/src/extensions/registry.ts`.

## Vendor patches

ltx-2-mlx / mflux patches in `python/mlx-movie-director/app/vendor_patches.py`. Never edit vendor submodules directly; add via `_patch_*()` → `apply_all_patches()`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`ziyu4huang/video_generation`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Multi-context — each domain owns its own `CONTEXT.md` + `docs/adr/` (e.g. `bun-apps/pi-agent-cli/`). A root `CONTEXT-MAP.md` lists contexts once a second one is captured. See `docs/agents/domain.md`.
