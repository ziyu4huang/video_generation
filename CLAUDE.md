# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Video Generation — MLX on Apple Silicon

> ## ⚠️ ComfyUI is DEPRECATED (abandoned 2026-06-21)
> The ComfyUI code path is **outdated and no longer maintained** — do NOT invest
> effort in it. This includes the `ComfyUI/` submodule, `patches/comfyui/`,
> `ComfyUI/.venv`, the removed `run.sh` (`:8188` server), and the ComfyUI workflow JSONs.
>
> The **active stack** is the **MLX pipeline** (`python/mlx-movie-director/run.py`)
> driven by the **Bun GUI** (`bun-apps/gui-movie-director`). The Bun app only ever
> spawns `run.py` — it never invokes ComfyUI — and the MLX runtime was fully
> decoupled from `comfyui_data/` at runtime (commit `aab6150`). ComfyUI content is
> quarantined to the **"ComfyUI — DEPRECATED"** section at the bottom of this file
> (historical reference only). `comfyui_data/models/` survives solely as raw
> download sources for `convert.py` (build-time, not runtime).

## Communication

- **Conversation language**: 繁體中文 (zh_TW) — use zh_TW for discussion, explanations, and Q&A
- **Written output**: English — all docs, code comments, commit messages, and file content in English

## Active stack

Image/video generation runs via **MLX on Apple Silicon**, surfaced through a **Bun + React GUI**:

- **MLX pipeline** — `python/mlx-movie-director/run.py` (Z-Image / Flux2 Klein / Lens / LTX-2.3 / SeedVR2, all native MLX). The only generation runtime.
- **Bun GUI** — `bun-apps/gui-movie-director` (`bun run dev`; port is per-worktree — discover with `bun run gui:port`). Spawns `run.py`; never touches ComfyUI.

## Python — Choose the Right Venv

```bash
# mlx-movie-director (image/video generation) — from repo root only
python/venv/bin/python python/mlx-movie-director/run.py <args>

# NEVER: python3 / python3.13 (system/uv-managed, no project deps)
# (ComfyUI/.venv is DEPRECATED — abandoned; do not use.)
```

> **Invoke from repo root only.** The mlx venv is at `python/venv/` (not inside `python/mlx-movie-director/`). Running `cd python/mlx-movie-director && python/venv/bin/python run.py` fails — the relative path breaks after `cd`. `run.py` resolves model paths from `__file__`, so cwd doesn't matter.

## Platform: Apple Silicon MPS

- **No CUDA attention**: SageAttention, Flash Attention, xformers need CUDA. SDPA only on MPS (mflux / LTX-2-mlx both use SDPA).

(The FP8 `--supports-fp8-compute` patch, the Triton/decord stub, and the
Face DetailerForEach bypass were ComfyUI-runtime concerns — see the deprecated
section. The Triton/decord stub installer and the ComfyUI bench scripts were
removed with the abandoned ComfyUI path.)

### Data types (dtypes) — MLX, not torch

The "BF16 gold standard" guidance belongs to **ComfyUI/torch** (`_compute_dtype =
torch.bfloat16`, M3/M4 native). This repo runs **MLX**, so the equivalent
truth is MLX-shaped:

- **`bfloat16` (`mx.bfloat16`) is the native full-precision compute dtype** for
  transformer inference on Apple Silicon. `mflux` and the MLX pipelines
  load/store bf16 weights. Prefer bf16 over fp16: it shares fp16's range without
  the overflow risk in attention scores / large activations.
- **Quantize for memory, not speed.** `import-checkpoint` / `import-lora-image`
  quantize to **8-bit MLX (`mlx-8bit`)** by default; some transformers ship
  **4-bit** (e.g. `dark-beast-dbzit9`). Mixed bit/group-size exists per module
  (e.g. LTX transformer `int8/g64`, connector `int4/g32` — see Patch 11).
- **No FP8 path.** FP8 fused matmul (`torch._scaled_mm`, `--supports-fp8-compute`)
  is torch/ComfyUI only; MLX has no FP8 kernel. Do not port FP8 recipes here.

## Startup

```bash
cd bun-apps/gui-movie-director && bun run dev   # ACTIVE — GUI (port is per-worktree, see below)
bun run gui:port                           # this worktree's url (--all lists every server)
```

`./run.sh` (the ComfyUI server on `:8188`) was **removed 2026-06-21** — it was pure ComfyUI;
the GUI above is the only entry point.

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

3-stage end-to-end pipeline: ZImage T2I → VLM prompt assistant → LTX I2V.

```bash
# With VLM prompt expansion (recommended)
python/venv/bin/python python/mlx-movie-director/run.py video t2i2v \
  --prompt "a woman in a garden" \
  --action "她微笑走向鏡頭，輕聲說「嗯…你來了」" \
  --frames 97 --seed 99

# Without VLM (use raw prompt directly for video)
python/venv/bin/python python/mlx-movie-director/run.py video t2i2v \
  --prompt "a woman in a garden" --frames 25
```

Key args: `--t2i-transformer` (default: `moody-pro-mix`), `--transformer` (LTX variant, default: `dasiwa`),
`--action` (user's action intent in zh-TW; omit to skip VLM stage), `--t2i-width/height` (default: 640×960).
Output: `<output>/t2i2v_YYYYMMDD_HHMMSS/` with `image.png`, `vlm_prompt.json`, video, and `t2i2v_manifest.json`.

## Lens T2I (`--pipeline lens`)

Microsoft Lens 3.8B — separate model family from Z-Image/Flux (no LoRA, ControlNet, or shared args).

```bash
python/venv/bin/python python/mlx-movie-director/run.py image t2i --pipeline lens --prompt '...'
python/venv/bin/python python/mlx-movie-director/run.py image t2i --pipeline lens --self-test
```

Defaults: `--width 512 --height 512 --steps 20 --cfg-scale 4.0 --seed 777`. Higher res (1024²) + 50 steps → better quality. Requires ~16 GB INT4 models. Full implementation notes: `docs/lens-mlx-t2i-rope-patchify.md`.

## Image Caption

Use `run.py caption` for local images via Qwen3-VL 4B (LM Studio). **Prefer over MCP tools** — MCP cannot read local paths.

```bash
python/venv/bin/python python/mlx-movie-director/run.py caption <IMAGE> [--style <style>] [--lang en]
```

Styles: `default`, `photography`, `t2i`, `profile`, `style`, `score`, `compare`, `review`, `playwright`, `ltx_i2v`.
Output: `<image>.caption.json`. Requires LM Studio running locally.

The `ltx_i2v` style takes `--action <intent>` and generates an LTX-optimized I2V prompt (motion + zh-TW voice lines):
```bash
python/venv/bin/python python/mlx-movie-director/run.py caption <IMAGE> --style ltx_i2v --action "她微笑走向鏡頭"
```

## Bun GUI Server

```bash
cd bun-apps/gui-movie-director && bun run dev    # hot reload (port is per-worktree)
bun run gui:port                            # this worktree's url; --all lists every server
```

**Do NOT use `bun run start`** — no file watching. Use `bun run dev:watch` only if hot reload breaks.

**Port is per-worktree** (concurrent dev): the primary worktree (real `.git`) uses **3099**;
each linked worktree derives a stable port from its path (`lib/worktree.ts`). Don't assume
3099 — run `bun run gui:port` for yours. Kill a stuck server by its discovered port
(`lsof -ti :<port> | xargs kill -9`).

## Testing

```bash
# Bun (from bun-apps/gui-movie-director/)
bun test
bun run check:schema    # validate all command schemas against run.py CLI

# Python (from repo root)
python/venv/bin/python -m pytest python/mlx-movie-director/app/tests
python/venv/bin/python -m pytest python/mlx-movie-director/app/tests --run-gpu    # real MLX + Metal
```

Browser automation: use `playwright-cli` skill. Before automating, capture a screenshot and run
`run.py caption <shot> --style playwright --lang en` — the text snapshot shows structure but not
current field values or selected state; the caption fills that gap.

## Model Import Commands

### import-checkpoint (ZImage transformer)

```bash
python/venv/bin/python python/mlx-movie-director/run.py import-checkpoint \
  'https://civitai.com/models/...' [--name my-model]
```

Downloads bf16 safetensors from CivitAI, remaps ComfyUI keys, quantizes to 8-bit MLX,
**externalizes** `model.safetensors` to `../video_generation__models/<md5>.safetensors`,
and replaces it with a relative symlink. Only metadata files (`manifest.json`, `config.json`,
`README.md`) are committed to git — the large binary lives outside the repo.

### import-lora-image (ZImage LoRA)

```bash
python/venv/bin/python python/mlx-movie-director/run.py import-lora-image \
  'https://civitai.com/models/...' [--name my-lora]
```

Same externalization pattern: binary → `../video_generation__models/<md5>.safetensors`,
symlink committed to git.

### External model store invariant

Every `model.safetensors` (and LoRA `.safetensors`) **must** be a symlink pointing to
`../../../../../../video_generation__models/<md5>.safetensors`. The store index is tracked
in `python/mlx-movie-director/models/store-manifest.json`.

Both `import-checkpoint` and `import-lora-image` enforce this automatically. If you ever
add a model manually, run the same externalization step — never commit a raw binary.

## Key Directories

```
python/mlx-movie-director/            # ACTIVE — MLX pipeline
python/mlx-movie-director/models/     # ACTIVE — MLX-owned model tree (runtime paths live here)
python/mlx-movie-director/models/store-manifest.json  # tracks all externalized model files
../video_generation__models/          # EXTERNAL binary store (outside repo, gitignored)
bun-apps/gui-movie-director/               # ACTIVE — Bun + React GUI
comfyui_data/models/                  # raw sources for convert.py (BUILD-TIME ONLY) — NOT a runtime dep
ComfyUI/                              # DEPRECATED submodule (abandoned)
comfyui_data/custom_nodes/            # DEPRECATED (ComfyUI clones, gitignored)
comfyui_data/user/default/workflows/  # DEPRECATED ComfyUI workflow JSONs
patches/comfyui/                      # DEPRECATED git patches (applied by the removed run.sh)
```

## Known Issues & Fixes

See [`.claude/memory/MEMORY.md`](.claude/memory/MEMORY.md) for lessons learned across sessions.

## Dynamic Workflow Self-Improve — Execution SOP

Verified procedure for the self-improve dynamic workflows (`mlx-movie-director-self-improve`
for `python/mlx-movie-director/`, `gui-movie-director-self-improve` for `bun-apps/gui-movie-director/`).
These are multi-agent `Workflow` runs; the SOP keeps them reproducible and collision-safe across
concurrent sessions. Every step below is verified against the live workflow code + iters 1–7.

### 1. Branch + clean tree (before triggering)
- Branch off `origin/main` only (`dev` is retired — never a shared working branch):
  `git fetch origin && git switch -c mlx-selfimprove-iterN`.
- **`fix:true` refuses a dirty tree.** The parent's Resolve phase runs a dirty-tree check (haiku
  agent inspects `git status`); if any tracked file is modified/staged, `fix:true` is downgraded to
  review-only to avoid colliding with concurrent WIP. Commit/stash first, then re-run.
- The workflow `git stash`-checkpoints before applying fixes and selectively
  `git checkout HEAD -- <file>`-restores on regression — so its git ops sweep `python/mlx-movie-director/`
  (or `bun-apps/...`). **Do not edit files in that subtree while a run is in progress** (the run's stash/commit
  flow absorbs your WIP — `concurrent-session-sweeps-working-tree`).

### 2. Trigger via `scriptPath` (never `{name}`)
```js
Workflow({ scriptPath: "<repo>/.claude/workflows/mlx-movie-director-self-improve.js" },
          { effort: "medium", fix: true })
```
`Workflow({name})` serves a stale cached copy — always `{scriptPath}`. `effort`: `low` = routine
scan (~20 min, review-only); `medium` = applies verified fixes (~40–90 min, needs clean tree);
`high` = exhaustive. `fix:true` gates fixes behind adversarial verify + git-stash rollback +
post-restore full pytest.

### 3. Trust posture — verify before applying
- **Lint lane** (pyflakes / check-model / self-test): deterministic, trustworthy.
- **Review lane** (correctness / argparse-integrity / type-safety / error-handling / import-hygiene):
  has false positives. A finding can have a real symptom but a misdiagnosed root cause, or a fully
  fabricated runtime claim. **Trace the real code path before believing a behavior claim**; findings
  that mis-state a language primitive (`__exit__` always runs, `finally` runs) are FP
  (`mlx-self-improve-review-verify-before-applying`).
- The report names the **actual** reverted files — but still spot-check `git diff --stat` against
  the prose; a restore can be narrated wrong.

### 4. Ship the run's fixes (the workflow does NOT commit)
The workflow leaves verified fixes in the working tree (uncommitted). You commit + PR them:
1. `git add -A && git commit` (English message; end with the `Co-Authored-By: Claude` line).
2. `git push -u origin <branch>` then `gh pr create --base main --head <branch>`.
3. **Before merge — collision check** (multi-session repo; `origin/main` keeps moving):
   `git fetch origin && git rev-list --left-right --count origin/main...HEAD` (left=main-only,
   right=branch-only) and `git log HEAD..origin/main --oneline`. Another session may have fixed the
   same bug (2026-06-21: two sessions wrote byte-identical SeedVR2 NaN guards). If behind/colliding:
   `git rebase origin/main` (auto-skips identical patches) → `git push --force-with-lease`
   (**never** bare `--force`).
4. `gh pr merge <n> --squash` — **do NOT add `--delete-branch`** (`main` is checked out in the
   `video_generation__gui` worktree; `--delete-branch` fails the local step after the GitHub merge
   succeeds). Delete manually: `git push origin --delete <branch>`.
5. After merge, squash leaves `main` with a commit your branch lacks — realign:
   `git fetch origin && git reset --hard origin/main`. **Verify with `git rev-parse --short HEAD
   origin/main`** — don't trust the merge output alone (a race once left the pointer unmoved).

### Known machinery limits (don't try to "fix" in-script)
- **AGENT_CAP** (90/40/20 by effort) bounds total agent *spawns*, not a single agent looping
  internally past `StructuredOutput` (the iter-4 ~48-min haiku hang). That false-progress loop is a
  runtime-layer limit, not fixable from the workflow script — watch a run's live progress; one
  ballooning agent is the signature.
- **Operation-memory** (`<wf>.operation-lessons.jsonl`) injects curated fix/restore/report rules each
  run — the workflow's behavior posture self-corrects across runs, independent of project-memory.

## Vendor patches (active)

**Vendor patches** (ltx-2-mlx / mflux): live in `python/mlx-movie-director/app/vendor_patches.py`
as import-time monkey-patches. Never edit vendor submodules directly — `git submodule update` wipes
working-tree edits. Add new patches by appending a `_patch_*()` function and registering it in
`apply_all_patches()`.

---

# ComfyUI — DEPRECATED (abandoned 2026-06-21, historical reference only)

The content below documents the abandoned ComfyUI path. **Do not maintain or extend it.**
`run.sh` (removed 2026-06-21) was the ComfyUI entry point — it bootstrapped `ComfyUI/.venv`,
applied `patches/comfyui/`, patched `comfy_kitchen`, restored custom nodes, and launched ComfyUI
`main.py` on `:8188`. It never touched MLX or the Bun GUI.

## ComfyUI Workflows (DEPRECATED)

| # | Name | File | Models |
|---|---|---|---|
| 1 | Anime → Real Style Transfer | `flux2-klein9b.json` | Flux 2 Klein 9B bf16 + anything2real LoRA |
| 2 | Multi-Pose Character Sheet | `anime2real.json` | Flux 2 Klein 9B bf16 |
| 3 | LTX-2.3 Video Generation | `ltx2.3-singularity.json` | LTX-2.3 22B bf16 + Singularity LoRA |
| 4 | Moody Zimage Photorealistic | `moody-zimage-v7.5.json` | Moody V12.6 DPO + SeedVR2 7B |

## ComfyUI Patches (DEPRECATED)

Git patches in `patches/comfyui/` were auto-applied by `run.sh` (ComfyUI only; `run.sh` was removed 2026-06-21).
FP8 compute (`--supports-fp8-compute` + the `fp8-mps-metal` custom node patching `comfy_kitchen.scaled_mm_v2`
→ Metal kernels), the Triton/decord macOS stubs, and the Face DetailerForEach MPS INT_MAX bypass all
belonged to this path. See `docs/fp8-mps-apple-silicon.md`.

## ComfyUI Filename Tokens (DEPRECATED)

ComfyUI SaveImage `filename_prefix`: `%year%`, `%month%`, `%day%`, `%hour%`, `%minute%`, `%second%`,
`%width%`, `%height%`. (`%date:...%` needs pysssss plugin — won't resolve without it.)
