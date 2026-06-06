#!/usr/bin/env bash
set -e
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
COMFY_DIR="$REPO_DIR/ComfyUI"
DATA_DIR="$REPO_DIR/comfyui_data"
PATCHES_DIR="$REPO_DIR/patches/comfyui"
VENV="$COMFY_DIR/.venv"

# ── Parse run.sh-level options (strip before passing remaining args to ComfyUI) ──
# Usage:
#   ./run.sh --fix-nodes          clone/patch missing custom nodes (verbose), then exit
#   ./run.sh --skip-restore       skip the auto-restore step for faster startup
#   ./run.sh --port 8189 ...      all other args are passed through to ComfyUI main.py
FIX_NODES=false
SKIP_RESTORE=false
PORT=8188
PASSTHROUGH_ARGS=()
_PREV_ARG=""
for arg in "$@"; do
  case "$arg" in
    --fix-nodes)    FIX_NODES=true ;;
    --skip-restore) SKIP_RESTORE=true ;;
    *)
      if [ "$_PREV_ARG" = "--port" ]; then PORT="$arg"; fi
      PASSTHROUGH_ARGS+=("$arg")
      ;;
  esac
  _PREV_ARG="$arg"
done

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
  # groundingdino-py may fail on some platforms — non-critical (RMBG uses fallback)
  "$VENV/bin/pip" install groundingdino-py -q || true
  echo "[run.sh] Installing platform stubs (triton/decord unavailable on macOS)..."
  bash "$REPO_DIR/scripts/install_stubs.sh" "$VENV"
  echo "[run.sh] venv ready."
fi

# Always ensure stubs are present (in case venv was created without them)
bash "$REPO_DIR/scripts/install_stubs.sh" "$VENV"

# Apply patches to submodule if not already applied
for patch in "$PATCHES_DIR"/*.patch; do
  [ -f "$patch" ] || continue
  if ! git -C "$COMFY_DIR" apply --check --reverse "$patch" 2>/dev/null; then
    echo "[run.sh] Applying patch: $(basename "$patch")"
    git -C "$COMFY_DIR" apply "$patch"
  fi
done

# Auto-restore missing custom nodes (clones from manifest, applies patches)
if $FIX_NODES; then
  echo "[run.sh] Running custom node fix (verbose)..."
  bash "$REPO_DIR/patches/custom_nodes/reinstall.sh"
  echo "[run.sh] Done."
  exit 0
elif $SKIP_RESTORE; then
  echo "[run.sh] Skipping custom node restore (--skip-restore)."
else
  bash "$REPO_DIR/patches/custom_nodes/reinstall.sh" --quiet
fi

# Check if the target port is already in use
if lsof -iTCP:"$PORT" -sTCP:LISTEN -t &>/dev/null; then
  PIDS=$(lsof -iTCP:"$PORT" -sTCP:LISTEN -t)
  echo "ERROR: Port $PORT is already in use by PID(s): $PIDS"
  echo ""
  echo "To kill the existing server and free the port:"
  echo "  kill $PIDS"
  echo ""
  echo "Or to force kill (if the above doesn't work):"
  echo "  kill -9 $PIDS"
  exit 1
fi

# MPS memory: disable high-watermark throttling, allow CPU fallback for unsupported ops
export PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0
export PYTORCH_ENABLE_MPS_FALLBACK=1

cd "$COMFY_DIR"
.venv/bin/python main.py \
  --base-directory "$DATA_DIR" \
  --database-url "sqlite:///$DATA_DIR/user/comfyui.db" \
  --use-split-cross-attention \
  --supports-fp8-compute \
  "${PASSTHROUGH_ARGS[@]}"
  # --supports-fp8-compute: stores FP8 model weights as uint8 on MPS (same bits, valid dtype).
  # The fp8-mps-metal custom node patches comfy_kitchen.scaled_mm_v2 to use Metal GPU kernels,
  # so the "Invalid scaling configuration" (Byte vs Float8) error is now fixed.
