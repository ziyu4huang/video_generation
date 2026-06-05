#!/usr/bin/env bash
########################################
# hf_status.sh — Unified HF model inventory
#
# Scans HF Hub cache, local MLX models, and mflux models.
# Reports sizes, shared/dedup status, and per-app usage.
#
# USAGE:
#   ./scripts/hf_status.sh
########################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HF_CACHE="${HF_HOME:-$HOME/.cache/huggingface}"

echo "=== HuggingFace Model Inventory ==="
echo ""

# --- HF Hub Cache ---
echo "--- HF Hub Cache ($HF_CACHE) ---"
if command -v huggingface-cli &>/dev/null; then
  huggingface-cli scan-cache 2>/dev/null || echo "  (scan failed)"
else
  if [ -d "$HF_CACHE/hub" ]; then
    du -sh "$HF_CACHE" 2>/dev/null
    echo "  Install huggingface-cli for detailed scan: pip install huggingface_hub"
  else
    echo "  No HF cache found"
  fi
fi
echo ""

# --- Local MLX models per app ---
echo "--- Local Models ---"

for dir in \
  "$PROJECT_ROOT/bun_app/video_gen_m5/models" \
  "$PROJECT_ROOT/python_app/generate_image/models"; do
  if [ -d "$dir" ]; then
    app=$(echo "$dir" | sed "s|$PROJECT_ROOT/||")
    echo "$app:"
    for model_dir in "$dir"/*/; do
      [ -d "$model_dir" ] || continue
      size=$(du -sh "$model_dir" 2>/dev/null | cut -f1)
      echo "  $(basename "$model_dir"): $size"
    done
  fi
done

# --- mflux cache ---
if [ -d "$HOME/.cache/mflux-models" ]; then
  echo "mflux (~/.cache/mflux-models/):"
  du -sh "$HOME/.cache/mflux-models" 2>/dev/null | awk '{print "  Total: " $1}'
fi
echo ""

# --- Total ---
echo "--- Summary ---"
total=0
if [ -d "$HF_CACHE" ]; then
  hf_size=$(du -sm "$HF_CACHE" 2>/dev/null | cut -f1)
  total=$((total + hf_size))
  echo "  HF Hub cache: ${hf_size}MB"
fi
for dir in \
  "$PROJECT_ROOT/bun_app/video_gen_m5/models" \
  "$PROJECT_ROOT/python_app/generate_image/models"; do
  if [ -d "$dir" ]; then
    app_size=$(du -sm "$dir" 2>/dev/null | cut -f1)
    total=$((total + app_size))
    app=$(echo "$dir" | sed "s|$PROJECT_ROOT/||")
    echo "  $app: ${app_size}MB"
  fi
done
if [ -d "$HOME/.cache/mflux-models" ]; then
  mflux_size=$(du -sm "$HOME/.cache/mflux-models" 2>/dev/null | cut -f1)
  total=$((total + mflux_size))
  echo "  mflux cache: ${mflux_size}MB"
fi
echo "  Total: $((total / 1024))GB"
