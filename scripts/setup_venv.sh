#!/usr/bin/env bash
########################################
# setup_venv.sh — Create unified Python venv for all Python apps
#
# Creates ~/proj/unified_venv with merged deps and symlinks
# each compatible app's .venv to it.
#
# USAGE:
#   ./scripts/setup_venv.sh              # create + install + symlink
#   ./scripts/setup_venv.sh --no-install # create venv only, skip pip install
#   ./scripts/setup_venv.sh --check      # verify current setup
########################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="$HOME/proj/unified_venv"
REQUIREMENTS="$SCRIPT_DIR/requirements-unified.txt"

NO_INSTALL=0
CHECK_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --no-install) NO_INSTALL=1 ;;
    --check) CHECK_ONLY=1 ;;
    --help|-h)
      echo "Usage: $0 [--no-install] [--check]"
      echo "  --no-install  Create venv without installing packages"
      echo "  --check       Verify current setup without changes"
      exit 0
      ;;
  esac
done

# --- Apps that share unified venv ---
SHARED_APPS=(
  "$PROJECT_ROOT/bun_app/video_gen_m5"
  "$PROJECT_ROOT/python_app/generate_image"
  "$PROJECT_ROOT/python_app/mlx_music"
  "$PROJECT_ROOT/python_app/mlx_tts"
)

# --- Apps that keep isolated venvs ---
ISOLATED_APPS=(
  "$PROJECT_ROOT/python_app/comfyui"
)

# --- Check mode ---
if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "=== Unified Venv Check ==="
  echo ""

  if [ -d "$VENV_DIR" ]; then
    echo "[OK] $VENV_DIR exists"
    if [ -f "$VENV_DIR/bin/python" ]; then
      PY_VER=$("$VENV_DIR/bin/python" --version 2>&1)
      echo "[OK] Python: $PY_VER"
    fi
  else
    echo "[MISSING] $VENV_DIR not found — run $0 to create"
  fi

  echo ""
  echo "=== Symlinks ==="
  for app in "${SHARED_APPS[@]}"; do
    venv_link="$app/.venv"
    name=$(basename "$(dirname "$app")")/$(basename "$app")
    if [ -L "$venv_link" ]; then
      target=$(readlink "$venv_link")
      echo "[OK] $name/.venv → $target"
    elif [ -d "$venv_link" ]; then
      echo "[LOCAL] $name/.venv is a real directory (not symlinked)"
    else
      echo "[MISSING] $name/.venv not found"
    fi
  done

  echo ""
  echo "=== Isolated (keep separate) ==="
  for app in "${ISOLATED_APPS[@]}"; do
    name=$(basename "$app")
    if [ -d "$app/.venv" ]; then
      echo "[OK] $name has isolated .venv"
    else
      echo "[INFO] $name has no .venv"
    fi
  done

  exit 0
fi

# --- Create venv ---
echo "=== Creating Unified Venv ==="

if [ -d "$VENV_DIR" ]; then
  echo "[OK] $VENV_DIR already exists"
else
  echo "Creating $VENV_DIR ..."
  python3 -m venv "$VENV_DIR"
  echo "[OK] Created"
fi

# Upgrade pip
"$VENV_DIR/bin/pip" install --upgrade pip 2>/dev/null || true

# --- Install deps ---
if [ "$NO_INSTALL" -eq 0 ] && [ -f "$REQUIREMENTS" ]; then
  echo ""
  echo "=== Installing Packages ==="
  "$VENV_DIR/bin/pip" install -r "$REQUIREMENTS"
  echo "[OK] Packages installed"
fi

# --- Create symlinks ---
echo ""
echo "=== Creating Symlinks ==="

for app in "${SHARED_APPS[@]}"; do
  venv_link="$app/.venv"
  name=$(basename "$(dirname "$app")")/$(basename "$app")

  if [ -L "$venv_link" ]; then
    current=$(readlink "$venv_link")
    if [ "$current" = "$VENV_DIR" ]; then
      echo "[OK] $name/.venv → unified_venv (already linked)"
    else
      echo "[WARN] $name/.venv → $current (points elsewhere, skipping)"
    fi
  elif [ -d "$venv_link" ]; then
    echo "[LOCAL] $name/.venv is a real directory"
    echo "  To migrate: rm -rf $venv_link && ln -s $VENV_DIR $venv_link"
  else
    ln -s "$VENV_DIR" "$venv_link"
    echo "[LINKED] $name/.venv → $VENV_DIR"
  fi
done

echo ""
echo "=== Isolated Apps (no symlink) ==="
for app in "${ISOLATED_APPS[@]}"; do
  echo "  $(basename "$app") — keeps its own .venv"
done

echo ""
echo "=== Done ==="
echo "Venv: $VENV_DIR"
echo "Run '$0 --check' to verify setup"
