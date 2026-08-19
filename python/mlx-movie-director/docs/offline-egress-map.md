# Offline Egress Map — mlx-movie-director

**Purpose:** enumerate every runtime network egress surface in the MLX
generation pipeline, and state for each whether it is **verified local-only**
or **gated behind `--offline`**. This is the reference for acceptance
criterion 6 of `output/next-goal-20260710_061001.md`.

**Scope:** `python/mlx-movie-director/` (the `run.py` MLX engine). Build-time
downloads (`import-checkpoint` / `import-lora` from CivitAI, `ltx_downloader`
first fetch) are *not* runtime egress — they run online once to populate the
local store, then generation is offline.

**The `--offline` contract (what the flag does):**

1. Sets `HF_HUB_OFFLINE=1` + `TRANSFORMERS_OFFLINE=1` → HuggingFace-backed
   loaders resolve **cache-only** and raise `LocalEntryNotFoundError` instead
   of fetching (see `app/offline.py::apply_offline`).
2. Runs a weight-presence **preflight** that fails loud before dispatch
   (`app/offline.py::preflight`) — never a silent fetch.
3. Skips stages that need a network service (the `video t2i2v` VLM/caption
   stage → LM Studio) unless `--vlm-online` is given.
4. Propagates to all `run.py` subprocess children via `build_run_py_cmd`
   (env vars inherit + `--offline` forwarded).

---

## Runtime egress surfaces

| # | Surface | File | Network call | Status under `--offline` |
|---|---------|------|--------------|--------------------------|
| 1 | LTX weight download | `app/ltx_downloader.py` | `huggingface_hub.hf_hub_download` (repo `dgrauet/ltx-2.3-mlx-q8`) | **Gated** — `HF_HUB_OFFLINE=1` → cache-only; preflight verifies the component dirs exist first. The downloader is a *build-time* tool (run once online); generation never calls it. |
| 2 | Z-Image / Flux2 / Lens weight load | `app/flux2_*.py`, `app/lens_pipeline.py` via `mflux.*.from_pretrained` | `huggingface_hub` cache lookup under the hood | **Verified local-only** — weights externalized to `mlx-models/` + `../video_generation__models/`; under `HF_HUB_OFFLINE=1` mflux resolves from the local cache (confirmed: self-test runs in ~12s with zero fetch). |
| 3 | LTX-2.3 video pipeline load | `app/ltx_pipeline.py` via `ltx_core_mlx` / `ltx_pipelines_mlx` | HF cache lookup (the "Fetching 13 files" line) | **Verified local-only** — 13 files resolve from cache at ~145k it/s (instant, no network); `HF_HUB_OFFLINE=1` guarantees no fetch. |
| 4 | Caption / T2I2V VLM stage | `app/commands/video-t2i2v.py` → `run.py caption` | `requests.post` → `http://localhost:1234/v1` (LM Studio) | **Gated** — `--offline` skips the stage by default (message: `VLM skipped (--offline; LM Studio is a network service)`); `--vlm-online` opts back in for a confirmed-local LM Studio. |
| 5 | Storyboard planning brain | `app/planning/gemma_brain.py::decompose_story` (+ `app/commands/story.py`, `app/commands/image-storyboard.py` which call it) | `requests.post` → LM Studio | **Gated** — raises `RuntimeError` under `--offline` instead of issuing the request; callers must fall back to a deterministic planner or be skipped. |
| 6 | Face restore / Real-ESRGAN bg | `app/face_restore_bridge.py` | `urllib.request` → GitHub release (`RealESRGAN_x4plus.pth`); sibling `CodeFormer` clone | **Gated** — vendored into `mlx-models/upscale/realesrgan/` (T4); the bridge resolves the local copy first and under `FACE_RESTORE_OFFLINE=1` fails loud instead of downloading. |
| 7 | i2i OpenPose conditioning | `app/commands/image-i2i.py::_ensure_pose_model` | `urllib.request` → Google Cloud Storage (`pose_landmarker_lite.task`) | **Gated** — under `--offline` raises instead of fetching; `_apply_openpose` catches it and **falls back to Canny** edge control (local). |
| 8 | Auxiliary LM Studio VLM features | `app/commands/image-faceswap.py`, `image-twosubject.py`, `app/lens_reasoner.py` (via `caption`) | `requests.*` → `localhost:1234` (LM Studio) | **Documented** — these are localhost-only VLM/LLM features, NOT on the core `image t2i` / `video generate` / `t2i2v` offline path. They require a running local LM Studio; they do not touch the public internet. |
| 9 | Checkpoint / LoRA / VAE / workflow import | `app/commands/import-checkpoint.py`, `import-lora-image.py`, `import-vae.py`, `import-workflow.py` | CivitAI API / image-URL download | **N/A (build-time)** — never on the generation runtime path; run online to populate the store, then generation is offline. |

---

## Verified local-only (no gating needed)

- **Image T2I** (`image t2i`, all pipelines: `zimage` / `flux2-klein` / `lens`)
  — weights load from `mlx-models/`; no runtime network. Self-test passes
  under `--offline` (criterion 1, verified 2026-07-10).
- **Video generate** (`video generate`, native LTX-2.3) — weights load from
  `mlx-models/ltx-mlx/*`; no runtime network. Self-test passes under
  `--offline` (criterion 2, verified 2026-07-10).

## Gated behind `--offline` (skip / fail-loud)

- **T2I2V VLM stage** (LM Studio) — skipped by default under `--offline`
  (criterion 3, verified 2026-07-10).
- **Storyboard brain** (LM Studio) — raises under `--offline`.
- **Missing weights** — preflight fails loud before dispatch (criterion 4,
  verified 2026-07-10).
- **Face-restore weights** — vendored; GitHub fetch only on explicit enable.

---

## How to verify the map stays accurate

```bash
# 1. Confirm no NEW network call sites slipped in (grep the generation tree):
grep -rn "requests\.\|httpx\.\|urllib\.\|hf_hub_download\|snapshot_download" \
  python/mlx-movie-director/app/ --include="*.py" | grep -v test | grep -v __pycache__

# 2. Run the offline smoke test (criterion 5):
python/venv/bin/python -m pytest python/mlx-movie-director/app/tests/test_offline.py -v --run-gpu

# 3. Prove zero-egress end-to-end (network blocked):
python/venv/bin/python python/mlx-movie-director/run.py image t2i --offline --self-test
python/venv/bin/python python/mlx-movie-director/run.py video generate --offline --self-test beach-walk
```

When adding a new generation command that loads weights, register its
components in `app/offline.py` (`_image_components` / `_video_components`) so
the preflight covers it. When adding a new network call, add a row here and
gate it under `--offline`.
