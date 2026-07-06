#!/usr/bin/env bash
# Install the sibling-fork dependencies the PyPI requirements.txt CANNOT provide.
#
# Two sibling repos supply packages this repo imports but which are not on PyPI
# (or whose PyPI versions lack the required modules):
#
#   1. mflux fork (../mflux, v0.17.5+)  — provides `mflux.models.z_image`
#      (the Z-Image VAE loader). REQUIRED for the IMAGE path. Upstream PyPI
#      mflux (0.12.x) lacks `models.z_image` → `run.py image` fails at decode.
#
#   2. ltx-2-mlx workspace (../ltx-2-mlx) — provides `ltx_core_mlx`,
#      `ltx_pipelines_mlx`, `ltx_trainer` via app/vendor_patches.py. REQUIRED
#      for the VIDEO path. Not on PyPI; the workspace root fails `uv pip
#      install -e` under PEP 639, so each `packages/*` member is installed
#      editable individually.
#
# Both forks leave `transformers` unpinned, so uv resolves the latest (5.x),
# which breaks `mlx_lm`'s `AutoTokenizer.register` (string vs class). This
# script re-asserts `transformers<5` at the end.
#
# Run AFTER `uv pip install -r python/mlx-movie-director/requirements.txt`.
#
# Usage:
#   bash scripts/setup-repo-deps.sh
#   MFLUX_DIR=/path/to/mflux LTX_2_MLX_DIR=/path/to/ltx-2-mlx bash scripts/setup-repo-deps.sh
#   VENV_PYTHON=/other/venv/bin/python bash scripts/setup-repo-deps.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

VENV_PYTHON="${VENV_PYTHON:-$REPO_ROOT/python/venv/bin/python}"
[ -x "$VENV_PYTHON" ] || {
  echo "✗ MLX venv python not found at $VENV_PYTHON" >&2
  echo "  Recreate it first:" >&2
  echo "    uv venv python/venv --python 3.12" >&2
  echo "    uv pip install -r python/mlx-movie-director/requirements.txt --python python/venv/bin/python" >&2
  exit 1
}

resolve_dir() {  # <env_var> <default_sibling> <label>
  local env="$1" sibling="$2" label="$3"
  local dir="${!env:-$REPO_ROOT/../$sibling}"
  if [ -d "$dir" ]; then
    (cd "$dir" && pwd)
  else
    echo "✗ $label not found at $dir (set $env to its path)" >&2
    return 1
  fi
}

MFLUX_DIR="$(resolve_dir MFLUX_DIR mflux 'mflux fork')"
LTX_DIR="$(resolve_dir LTX_2_MLX_DIR ltx-2-mlx 'ltx-2-mlx repo')"

echo "==> mflux fork:    $MFLUX_DIR"
echo "==> ltx-2-mlx:     $LTX_DIR"
echo "==> venv python:   $VENV_PYTHON"
echo

# 1. mflux fork (single editable install; provides z_image for the image path).
echo "→ installing mflux fork (editable)…"
uv pip install -e "$MFLUX_DIR" --python "$VENV_PYTHON"

# 2. ltx-2-mlx workspace members (each packages/* member; for the video path).
shopt -s nullglob
members=("$LTX_DIR"/packages/*/)
if [ ${#members[@]} -eq 0 ]; then
  echo "✗ no packages/* members found under $LTX_DIR" >&2
  exit 1
fi
for member in "${members[@]}"; do
  echo "→ installing $(basename "$member") (editable)…"
  uv pip install -e "$member" --python "$VENV_PYTHON"
done

# 3. Re-assert transformers<5. Both forks leave it unpinned → uv picks 5.x,
#    which breaks mlx_lm's AutoTokenizer.register and kills both image and
#    video paths. Force it back to the requirements.txt pin.
echo "→ re-asserting transformers<5 (forks don't pin it)…"
uv pip install "transformers>=4.46,<5" --python "$VENV_PYTHON"

echo
echo "✓ sibling-fork deps installed. Verify with:"
echo "    $VENV_PYTHON -c 'import mflux.models.z_image, ltx_core_mlx, ltx_pipelines_mlx; import transformers; print(\"transformers\", transformers.__version__)'"
echo "  Then the self-tests:"
echo "    $VENV_PYTHON python/mlx-movie-director/run.py image t2i --self-test"
echo "    $VENV_PYTHON python/mlx-movie-director/run.py video generate --self-test"
