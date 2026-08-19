#!/usr/bin/env bash
# setup-offline.sh — one-command bootstrap for FULLY-OFFLINE MLX generation.
#
# Creates python/venv, installs the MLX generation stack + sibling forks
# (mflux / ltx-2-mlx), then runs the offline weight preflight so a fresh
# clone — with model binaries already present in mlx-models/ and the
# external store — can generate image + video with ZERO runtime egress.
#
# WHEN TO RUN: once after a fresh clone (or after `git clean`), WHILE you
# still have network access (this is a build-time step). Once it succeeds,
# `run.py ... --offline` needs no network ever again.
#
# WHAT THIS DOES (network used ONLY here, never at generation time):
#   1. `uv venv python/venv`            — create the MLX venv
#   2. `uv pip install -r requirements` — MLX stack (mlx, transformers<5, …)
#   3. `bash scripts/setup-repo-deps.sh`— editable mflux fork + ltx-2-mlx
#   4. `run.py check-model --preflight` — verify all weights resolve locally
#
# WHAT IT DOES NOT DO: download model binaries. Those live in mlx-models/
# and ../video_generation__models/ (gitignored, per-machine). Populate them
# first via `python app/ltx_downloader.py`, `run.py import-checkpoint`, etc.
# (also build-time, online). If the preflight fails, it prints exactly what
# is missing and where to fetch it.
#
# Usage:
#   bash scripts/setup-offline.sh                # full bootstrap
#   bash scripts/setup-offline.sh --skip-venv    # venv already exists; just deps + preflight
#   PYTHON=python3.12 bash scripts/setup-offline.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PY="${PYTHON:-3.12}"
VENV_PY="python/venv/bin/python"
SKIP_VENV=0
for arg in "$@"; do
  case "$arg" in
    --skip-venv) SKIP_VENV=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

echo "── setup-offline.sh (repo: $REPO_ROOT) ──"

# ── 1. Create the MLX venv ──────────────────────────────────────────────────
if [ "$SKIP_VENV" -eq 1 ] || [ -x "$VENV_PY" ]; then
  echo "✓ python/venv exists ($VENV_PY) — skipping creation"
else
  echo "▸ creating python/venv (Python $PY)…"
  if ! command -v uv >/dev/null 2>&1; then
    echo "✗ 'uv' not found — install from https://docs.astral.sh/uv/" >&2
    exit 1
  fi
  uv venv python/venv --python "$PY"
  echo "✓ python/venv created"
fi

# ── 2. Install the MLX generation requirements ──────────────────────────────
# NOTE: requirements.txt lists mlx-whisper → numba → llvmlite which pins
# Python <3.10 (a pre-existing conflict on the analysis/whisper path, NOT the
# generation path). To keep this bootstrap robust, we install the generation
# core explicitly and let setup-repo-deps.sh add the sibling forks. If you need
# the whisper/analysis path, install mlx-whisper/mediapipe/edge-tts separately
# (they are not required for offline image/video generation).
echo "▸ installing MLX generation stack into python/venv…"
GEN_REQS=(
  "mlx>=0.20.0" torch torchvision numpy
  "diffusers>=0.25.0" "transformers>=4.46,<5" huggingface_hub Pillow safetensors
  accelerate hf_transfer tqdm opencv-python scipy scikit-image spandrel psutil
  requests pytest pytest-cov
)
uv pip install --python "$VENV_PY" "${GEN_REQS[@]}"

# ── 3. Sibling forks (mflux Z-Image VAE + ltx-2-mlx) ────────────────────────
echo "▸ installing sibling forks (mflux, ltx-2-mlx) + re-pinning transformers<5…"
bash scripts/setup-repo-deps.sh

# ── 4. Smoke import ─────────────────────────────────────────────────────────
echo "▸ verifying imports…"
"$VENV_PY" -c 'import mflux.models.z_image, ltx_core_mlx, ltx_pipelines_mlx, mlx.core, transformers; print("✓ imports OK (transformers", transformers.__version__, ")")'

# ── 5. Offline weight preflight ─────────────────────────────────────────────
echo "▸ running offline weight preflight…"
"$VENV_PY" python/mlx-movie-director/run.py check-model --preflight

cat <<EOF

✅ setup-offline complete. Generate fully offline:

    $VENV_PY python/mlx-movie-director/run.py image t2i --offline --self-test
    $VENV_PY python/mlx-movie-director/run.py video generate --offline --self-test beach-walk

If the preflight reported missing weights, fetch them ONLINE once:
    $VENV_PY python/mlx-movie-director/app/ltx_downloader.py        # LTX-2.3 components
    $VENV_PY python/mlx-movie-director/run.py import-checkpoint …   # image transformers/LoRA

See python/mlx-movie-director/docs/offline-egress-map.md for the full runtime-egress map.
EOF
