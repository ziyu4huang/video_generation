#!/usr/bin/env bash
set -e
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
COMFY_DIR="$REPO_DIR/ComfyUI"
DATA_DIR="$REPO_DIR/comfyui_data"
PATCHES_DIR="$REPO_DIR/patches/comfyui"
VENV="$COMFY_DIR/.venv"

# Bootstrap venv if missing
if [ ! -x "$VENV/bin/python" ]; then
  echo "[run.sh] .venv not found — creating..."
  PYTHON=$(command -v python3.13 || command -v python3 || echo "")
  [ -z "$PYTHON" ] && { echo "ERROR: python3 not found"; exit 1; }
  "$PYTHON" -m venv "$VENV"
  "$VENV/bin/pip" install --upgrade pip -q
  echo "[run.sh] Installing PyTorch (CPU/MPS build)..."
  "$VENV/bin/pip" install torch torchvision torchaudio \
    --index-url https://download.pytorch.org/whl/cpu -q
  echo "[run.sh] Installing ComfyUI requirements..."
  "$VENV/bin/pip" install -r "$COMFY_DIR/requirements.txt" -q
  echo "[run.sh] Installing custom node dependencies..."
  "$VENV/bin/pip" install onnxruntime transparent-background segment-anything \
    opencv-python protobuf hydra-core omegaconf iopath diffusers huggingface_hub -q
  echo "[run.sh] venv ready."
fi

# Apply patches to submodule if not already applied
for patch in "$PATCHES_DIR"/*.patch; do
  [ -f "$patch" ] || continue
  if ! git -C "$COMFY_DIR" apply --check --reverse "$patch" 2>/dev/null; then
    echo "[run.sh] Applying patch: $(basename "$patch")"
    git -C "$COMFY_DIR" apply "$patch"
  fi
done

cd "$COMFY_DIR"
.venv/bin/python main.py --base-directory "$DATA_DIR" "$@"
