# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Video Generation — MLX on Apple Silicon

## Communication

- **Conversation language**: 繁體中文 (zh_TW) — use zh_TW for discussion, explanations, and Q&A
- **Written output**: English — all docs, code comments, commit messages, and file content in English

## Active stack

Image/video generation runs via **MLX on Apple Silicon**, surfaced through a **Bun + React GUI**:

- **MLX pipeline** — `python/mlx-movie-director/run.py` (Z-Image / Flux2 Klein / Lens / LTX-2.3 / SeedVR2, all native MLX). The only generation runtime.
- **Bun GUI** — `bun-apps/gui-movie-director` (`bun run dev`; port is per-worktree — discover with `bun run gui:port`). Spawns `run.py`; never touches ComfyUI.

## Monorepo SOP — Bun-only, no `package-lock.json`

This is a **Bun workspace monorepo** (isolated linker + globalStore via root `bunfig.toml`); `bun.lock` is the **canonical** lockfile.

- **Never commit `package-lock.json`.** It is gitignored. If one appears (e.g. an editor/tool regenerates it), delete it — do not adapt the code to it.
- Add deps with `bun add` (writes `bun.lock`), never `npm install` (writes `package-lock.json`).
- Every `bun-apps/*` package is a workspace member; cross-package locals resolve as `workspace:*` in `bun.lock`. See [[bun-isolated-linker-global-store]].

## Python — Choose the Right Venv

```bash
# mlx-movie-director (image/video generation) — from repo root only
python/venv/bin/python python/mlx-movie-director/run.py <args>

# NEVER: python3 / python3.13 (system/uv-managed, no project deps)
# (ComfyUI/.venv is DEPRECATED — abandoned; do not use.)
```

> **Invoke from repo root only.** The mlx venv is at `python/venv/` (not inside `python/mlx-movie-director/`). Running `cd python/mlx-movie-director && python/venv/bin/python run.py` fails — the relative path breaks after `cd`. `run.py` resolves model paths from `__file__`, so cwd doesn't matter.

## Shell discipline — never top-level `cd`

A `PreToolUse` hook (`no-cd-drift.sh`) **blocks any top-level `cd <dir>`** in the Bash tool — the tool's cwd persists across calls, so drifting out of the repo root breaks repo-root-relative paths (`python/venv`, `run.py`, `dist/...`). Always do ONE of:

```bash
# 1. Wrap in a subshell (cwd resets after) — preferred for multi-step cmds
( cd swift/flux2-image-director && swift build -c release )

# 2. Tool-native --cwd / -C flags (no cd at all)
bun run --cwd bun-apps/gui-movie-director dev     # --cwd goes AFTER run
git -C bun-apps/pi-agent-cli status

# 3. Absolute paths from repo root (no cd at all)
python/venv/bin/python python/mlx-movie-director/run.py image t2i
```

A bare `cd swift/flux2-image-director && swift build ...` is rejected by the hook; wrap it as `( cd ... && ... )`. The same rule applies to every `cd ... && ...` one-liner in this file — when a command is shown un-wrapped, wrap it before running.

## Platform: Apple Silicon MPS

- **No CUDA attention**: SageAttention, Flash Attention, xformers need CUDA. SDPA only on MPS.
- **MLX dtypes**: `bfloat16` is native full-precision; quantize to `mlx-8bit` (default) or 4-bit. No FP8 path.

## Startup

```bash
( cd bun-apps/gui-movie-director && bun run dev )   # ACTIVE — GUI (port is per-worktree, see below)
bun run --cwd bun-apps/gui-movie-director gui:port  # this worktree's url (--all lists every server)
```

The GUI above is the only entry point (`./run.sh` was removed 2026-06-21).

**After a fresh clone**, enable the shared pre-commit hook (2 MB size guard):

```bash
bash scripts/setup.sh    # sets core.hooksPath = .githooks
```

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

Deprecated aliases: `generate` → `image`, `check-manifests` → `check-model`.

### Self-test flag

```bash
python/venv/bin/python python/mlx-movie-director/run.py image t2i --self-test
python/venv/bin/python python/mlx-movie-director/run.py image t2i --self-test t2i:portrait
python/venv/bin/python python/mlx-movie-director/run.py image i2i --self-test i2i:pose i2i:style
```

## Video T2I2V Pipeline (`video t2i2v`)

3-stage pipeline: ZImage T2I → VLM prompt assistant → LTX I2V. Omit `--action` to skip VLM stage. See [[t2i2v-pipeline]] memory for full args and examples.

## Lens T2I (`--pipeline lens`)

Microsoft Lens 3.8B — separate pipeline family, no LoRA/ControlNet. Defaults: 512×512, 20 steps, cfg=4.0. See [[project-lens-mlx]] memory for CLI details.

## Image Caption

`run.py caption <IMAGE> [--style <style>]` — local VLM analysis via Qwen3-VL 4B (LM Studio). **Prefer over MCP** — MCP cannot read local paths. See [[image-caption]] memory for all styles.

## Bun GUI Server

```bash
( cd bun-apps/gui-movie-director && bun run dev )   # hot reload (port is per-worktree)
bun run --cwd bun-apps/gui-movie-director gui:port  # this worktree's url; --all lists every server
```

**Do NOT use `bun run start`** — no file watching. Use `bun run dev:watch` only if hot reload breaks.

**Port is per-worktree** (concurrent dev): the primary worktree (real `.git`) uses **3099**;
each linked worktree derives a stable port from its path (`lib/worktree.ts`). Don't assume
3099 — run `bun run gui:port` for yours. Kill a stuck server by its discovered port
(`lsof -ti :<port> | xargs kill -9`).

## Testing

**Every Bun package runs plain `bun test`** (no flags, no `--isolate`, no `tsx`). From each package dir:

```bash
# Any bun-apps/* package — uniform runner
( cd bun-apps/<pkg> && bun test )
bun test scripts                                  # repo-root scripts suite

# gui-movie-director additionally validates command schemas against run.py
bun run --cwd bun-apps/gui-movie-director check:schema

# pi-dynamic-workflows builds first (tests import compiled ../src/*.js)
( cd bun-apps/pi-dynamic-workflows && bun run build && bun test )

# Python (from repo root)
python/venv/bin/python -m pytest python/mlx-movie-director/app/tests
python/venv/bin/python -m pytest python/mlx-movie-director/app/tests --run-gpu    # real MLX + Metal
```

**Runner pitfalls (now resolved, don't reintroduce):**
- Bun's `os.homedir()` ignores `process.env.HOME` at runtime (Node respects it). Tests that fake `$HOME` must read the env, not `homedir()` — see `bun-apps/pi-dynamic-workflows/src/home.ts`.
- `mock.module()` is process-global under plain `bun test` (files share one process). Mock only the module the code under test imports; don't mock a module that another test file exercises for real, or the stub leaks. (Resolving such a leak by adding `--isolate` is a workaround — prefer splitting the mocked export into its own module.)

Browser automation: use `playwright-cli` skill. Before automating, capture a screenshot and run
`run.py caption <shot> --style playwright --lang en` — the text snapshot shows structure but not
current field values or selected state; the caption fills that gap.

## Model Import Commands

`import-checkpoint` (transformer) and `import-lora-image` (LoRA) download from CivitAI, quantize to mlx-8bit, and auto-symlink binaries to `../video_generation__models/<md5>.safetensors`. Never commit raw safetensors. CIVITAI_TOKEN always available. See [[model-import]] memory for full commands.

## Key Directories

```
python/mlx-movie-director/            # ACTIVE — MLX pipeline
mlx-models/                           # ACTIVE — MLX-owned model tree (cwd-relative root; override via MLX_MODELS_DIR env / run.py --models-dir)
mlx-models/store-manifest.json        # tracks all externalized model files
../video_generation__models/          # EXTERNAL binary store (outside repo, gitignored)
bun-apps/gui-movie-director/               # ACTIVE — Bun + React GUI
comfyui_data/models/                  # raw sources for convert.py (BUILD-TIME ONLY) — NOT a runtime dep
```

## Known Issues & Fixes

See [`.claude/memory/MEMORY.md`](.claude/memory/MEMORY.md) for lessons learned across sessions.

## Dynamic Workflow Self-Improve

See [[self-improve-sop]] memory for the full procedure. Key: branch off `main` (dev retired), clean tree required for `fix:true`, always use `{scriptPath}` not `{name}`, do NOT `--delete-branch` on PR merge.

**Models for executing the loop** — this pi-agent + pi-dynamic-workflow combination is the core of the **AI loop self-development** setup (the `.claude/workflows/*` self-improve loops are the agent runtime improving itself). When executing these workflows, prefer:
- **Primary (local):** LM Studio serving `google/gemma-4-26b-a4b-qat`.
- **Fallback (if local isn't enough — heavy structured-output / long review):** `deepseek-v4-flash`.

Wire these via the workflow's `model-routing` / `model-tier-config`. Only escalate to the fallback if a run reports structured-output recovery or poor tool adherence — the loop only works when the model reliably calls the StructuredOutput tool.

**Infrastructure self-improve** — `pi-infra-self-improve` (`.claude/workflows/pi-infra-self-improve.js`) is the infrastructure-layer loop (pi-agent / pi-agent-cli / pi-dynamic-workflows / pi-vlm / pi-obsidian): contract lane (each package's real gate) + build lane (`pi-agent build:all` + `getAllTools()` probe) + review lane + opt-in **fix** lane (`fix:true`, dryRun-capable, dirty-tree-refuse, never-pushes). First adopter of the Self-Fix (Code-Review-Based) shared primitive in `_shared-patterns.md`. Run after touching any infra package.

## Vendor patches (active)

**Vendor patches** (ltx-2-mlx / mflux): live in `python/mlx-movie-director/app/vendor_patches.py`
as import-time monkey-patches. Never edit vendor submodules directly — `git submodule update` wipes
working-tree edits. Add new patches by appending a `_patch_*()` function and registering it in
`apply_all_patches()`.

