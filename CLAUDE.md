# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Video Generation — MLX on Apple Silicon

## Communication

- **Conversation language**: 繁體中文 (zh_TW) — use zh_TW for discussion, explanations, and Q&A
- **Written output**: English — all docs, code comments, commit messages, and file content in English

## Active stack

- **MLX pipeline** — `python/mlx-movie-director/run.py` (Z-Image / Flux2 Klein / Lens / LTX-2.3 / SeedVR2, all native MLX). The only generation runtime.
- **Bun GUI** — `bun-apps/gui-movie-director` (`bun run dev`; port is per-worktree — discover with `bun run gui:port`). Spawns `run.py`; never touches ComfyUI.

## Monorepo SOP — Bun-only, no `package-lock.json`

Bun workspace monorepo (isolated linker + globalStore via root `bunfig.toml`); `bun.lock` is canonical.

- **Never commit `package-lock.json`.** It is gitignored. If one appears, delete it.
- Add deps with `bun add`, never `npm install`. Every `bun-apps/*` is a workspace member (`workspace:*` in `bun.lock`). See [[bun-isolated-linker-global-store]].

## Python — Choose the Right Venv

```bash
# mlx-movie-director (image/video generation) — from repo root only
python/venv/bin/python python/mlx-movie-director/run.py <args>
# NEVER: python3 / python3.13 (system/uv-managed, no project deps)
# ComfyUI/.venv is DEPRECATED — do not use.
```

> **Invoke from repo root only.** The mlx venv is at `python/venv/` (not inside `python/mlx-movie-director/`). `run.py` resolves model paths from `__file__`, so cwd doesn't matter — but `cd` breaks the relative venv path.

> **`python/venv` is NOT auto-created** (gitignored, per-machine). On fresh clone, recreate it: `bash scripts/setup-offline.sh` (venv + sibling forks + preflight in one command), or manually: `uv venv python/venv --python 3.12 && uv pip install -r python/mlx-movie-director/requirements.txt --python python/venv/bin/python && bash scripts/setup-repo-deps.sh`.
>
> **Sibling-fork deps (not on PyPI):** `mflux` fork (`../mflux`, provides `mflux.models.z_image` — REQUIRED for IMAGE path) and `ltx-2-mlx` workspace (`../ltx-2-mlx`, REQUIRED for VIDEO path). Both installed by `scripts/setup-repo-deps.sh`, which also re-asserts `transformers<5` (5.x breaks `mlx_lm`'s `AutoTokenizer.register`). Override: `MFLUX_DIR=...` / `LTX_2_MLX_DIR=...`.

## Shell discipline — never top-level `cd`

A `PreToolUse` hook (`no-cd-drift.sh`) **blocks any top-level `cd`** — the tool's cwd persists, so drifting out of repo root breaks root-relative paths. Always wrap: `( cd <dir> && ... )`, use `--cwd`/`-C`, or use absolute paths.

## Platform: Apple Silicon MPS

- **No CUDA attention**: SDPA only on MPS (no SageAttention/Flash Attention/xformers).
- **MLX dtypes**: `bfloat16` native; quantize to `mlx-8bit` (default) or 4-bit. No FP8.

## Startup

```bash
( cd bun-apps/gui-movie-director && bun run dev )   # GUI (port is per-worktree)
bun run --cwd bun-apps/gui-movie-director gui:port  # this worktree's url (--all lists all)
```

The GUI is the only entry point (`./run.sh` was removed 2026-06-21). **Do NOT use `bun run start`** (no file watching). Use `bun run dev:watch` only if hot reload breaks. Port: primary worktree = 3099; linked worktrees derive from path (`lib/worktree.ts`). Kill stuck server: `lsof -ti :<port> | xargs kill -9`.

**Fresh clone:** `bash scripts/setup.sh` (sets `core.hooksPath = .githooks`, 2 MB size guard).

## run.py Subcommands

All commands: `python/venv/bin/python python/mlx-movie-director/run.py <cmd>`.

```
image [subcommand]   default: t2i
  t2i, angle, review, profile, controlnet, i2i, faceswap, swap,
  anime2real, quality, workflow, expansion, purify, restore
video [subcommand]   default: generate
  generate, review, compare, quality, restore, vbvr, relay, segment, t2i2v
caption <image>      VLM image analysis (see below)
replay <manifest>    re-run from JSON manifest
upscale              ESRGAN-only upscale
check-model          model manifest validation
schema               print full CLI schema as JSON
schema-defaults      print defaults for a given action
```

Self-test: `--self-test` or `--self-test t2i:portrait`. Deprecated: `generate` → `image`, `check-manifests` → `check-model`.

### Offline generation (`--offline`)

Zero runtime network egress: sets `HF_HUB_OFFLINE=1`/`TRANSFORMERS_OFFLINE=1`, runs weight-preflight (aborts if missing), skips network-dependent stages. Propagates to children. Bootstrap: `bash scripts/setup-offline.sh`. Full egress map: [`docs/offline-egress-map.md`](docs/offline-egress-map.md).

## Pipelines & Tools

- **T2I2V** (`video t2i2v`): ZImage T2I → VLM prompt → LTX I2V. Omit `--action` to skip VLM. See [[t2i2v-pipeline]].
- **Lens T2I** (`--pipeline lens`): Microsoft Lens 3.8B, no LoRA/ControlNet. Defaults: 512×512, 20 steps, cfg=4.0. See [[project-lens-mlx]].
- **Image Caption**: `run.py caption <IMAGE> [--style <style>]` — local VLM via Qwen3-VL 4B (LM Studio). Prefer over MCP (MCP can't read local paths). See [[image-caption]].
- **Model Import**: `import-checkpoint` / `import-lora-image` download from CivitAI, quantize to mlx-8bit, symlink to `../video_generation__models/`. Never commit raw safetensors. CIVITAI_TOKEN always available. See [[model-import]].

## Testing

```bash
( cd bun-apps/<pkg> && bun test )                    # any bun-apps/* package — uniform runner
bun run --cwd bun-apps/gui-movie-director check:schema  # validate command schemas vs run.py
( cd bun-apps/pi-agent-ext-workflow && bun run build && bun test )  # builds first (tests import ../src/*.js)
python/venv/bin/python -m pytest python/mlx-movie-director/app/tests [--run-gpu]
```

**Runner pitfalls (resolved — don't reintroduce):** Bun's `os.homedir()` ignores `process.env.HOME` at runtime — fake-$HOME tests must read env. `mock.module()` is process-global under plain `bun test` — mock only the module the code imports; don't mock a module another test file exercises for real.

Browser automation: `playwright-cli` skill. Screenshot + `run.py caption <shot> --style playwright --lang en` fills the field-value gap.

## Key Directories

```
python/mlx-movie-director/    # ACTIVE — MLX pipeline
mlx-models/                   # MLX-owned model tree (override: MLX_MODELS_DIR / --models-dir)
../video_generation__models/  # EXTERNAL binary store (outside repo, gitignored)
bun-apps/gui-movie-director/  # ACTIVE — Bun + React GUI
comfyui_data/models/          # raw sources for convert.py (BUILD-TIME ONLY)
```

`.planning/` and root `task_plan.md`/`findings.md`/`progress.md` are **task-planning scratch** (`pi-planning-with-files`) — **gitignored, never commit**. They're working memory on disk; if the reasoning matters, put it in the PR description or the vault (`zk_ingest`), not in checked-in scratch.

## Knowledge & Memory

Two layers: **working memory** (`memory`/`memory_search` → `~/.pi/agent/pi-hermes-memory/`) and **durable vault** (`zk_ask`/`zk_ingest` → `Zettelkasten/`, all sources converge into one graph). See [`bun-apps/pi-agent/docs/knowledge-orchestration.md`](bun-apps/pi-agent/docs/knowledge-orchestration.md). (Legacy `.claude/memory/` retired 2026-07-08 — 100% duplicated by vault + Platform section.)

## Dynamic Workflow Self-Improve

See [[self-improve-sop]]. Key rules: branch off `main`, clean tree for `fix:true`, use `{scriptPath}` not `{name}`, after squash-merge DELETE branches + detach (`git checkout --detach origin/main` → `git branch -D <br>` → `git fetch --prune`).

**Models:** Primary = LM Studio `google/gemma-4-26b-a4b-qat`; Fallback = `deepseek-v4-flash` (only if structured-output recovery or poor tool adherence). Wire via `model-routing`/`model-tier-config`.

**Infra loop:** `pi-infra-self-improve` (`.claude/workflows/pi-infra-self-improve.js`) — contract + build + review + opt-in fix lanes. Run after touching any infra package.

## Branch hygiene — SOP #320

Run `./scripts/stale-branches.sh` after every merge (expect **0 stale** on clean repo). `--prune` deletes. For the full worktree-safe merge→cleanup flow (squash-merge, base-update sync, branch delete, prune), use `./scripts/pr-finish.sh <PR#>` (it ends by calling `stale-branches.sh`; `--dry-run` previews). Full procedure: **`branch-cleanup`** project skill.

## Vendor patches (active)

ltx-2-mlx / mflux patches live in `python/mlx-movie-director/app/vendor_patches.py` as import-time monkey-patches. Never edit vendor submodules directly (`git submodule update` wipes edits). Add patches via `_patch_*()` → register in `apply_all_patches()`.
