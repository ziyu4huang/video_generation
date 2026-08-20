#!/usr/bin/env bash
#
# build-metallib.sh — build mlx-swift's default.metallib and colocate it with
# the musicgen release binary so MLX can load its Metal kernels at runtime.
#
# WHY THIS EXISTS
# --------------
# mlx-swift 0.31.4's SwiftPM target (Cmlx) does NOT build the Metal shader
# library — that step lives in the Xcode project's "PrepareMetalShaders" phase
# (see mlx-swift/Source/Cmlx/mlx/cmake/extension.cmake). A plain
# `swift build -c release` therefore produces a musicgen binary with NO metallib,
# and every MLX compute call (t2i / scene / gate-on-image / segment / …) dies:
#
#   MLX error: Failed to load the default metallib. library not found …
#
# At runtime MLX's device.cpp::load_default_library() looks for the metallib in
# this order (first hit wins):
#   1. <binary_dir>/mlx.metallib            ← what we produce here
#   2. <binary_dir>/Resources/mlx.metallib
#   3. SwiftPM bundle default.metallib      (not wired for a raw SPM exe)
#   4. <binary_dir>/Resources/default.metallib
#   5. $METAL_PATH                          (compiled-in as "default.metallib")
#
# So we compile all mlx Metal kernels into <binary_dir>/mlx.metallib. This
# mirrors what mlx's own CMake does (xcrun -sdk macosx metal … kernels/*.metal).
#
# USAGE
# -----
#   bash swift/musicgen-director/scripts/build-metallib.sh
#
# Run AFTER `swift build -c release` (the script needs the mlx-swift checkout
# under .build/checkouts, which swift build populates). Idempotent: skips when
# mlx.metallib is newer than every kernel source. Rebuilds when kernels change.
#
# This is invoked automatically by bun-apps/s2-agent-ext-movie-director/src/musicgen_binary.ts
# after a fresh swift build, so the agent tool gets a working binary without manual steps.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$PKG_DIR/.build"
RELEASE_DIR="$BUILD_DIR/release"
MLX_CHECKOUT="$BUILD_DIR/checkouts/mlx-swift/Source/Cmlx/mlx"
KERNELS_DIR="$MLX_CHECKOUT/mlx/backend/metal/kernels"
OUT="$RELEASE_DIR/mlx.metallib"

# Locate the mlx-swift checkout even if SwiftPM placed it under an artifact dir.
if [[ ! -d "$KERNELS_DIR" ]]; then
  ALT="$(find "$BUILD_DIR/checkouts" -maxdepth 6 -type d -path '*mlx-swift/Source/Cmlx/mlx/mlx/backend/metal/kernels' 2>/dev/null | head -1 || true)"
  if [[ -n "$ALT" ]]; then KERNELS_DIR="$ALT"; MLX_CHECKOUT="$(cd "$ALT/../../.." && pwd)"; fi
fi
if [[ ! -d "$KERNELS_DIR" ]]; then
  echo "✕ mlx-swift kernel sources not found under .build/checkouts." >&2
  echo "  Run 'swift build -c release --package-path $PKG_DIR' first." >&2
  exit 1
fi
mkdir -p "$RELEASE_DIR"

# Idempotent: skip if mlx.metallib exists and is newer than every .metal/.h src.
if [[ -f "$OUT" ]]; then
  NEWEST_SRC="$(find "$KERNELS_DIR" -type f \( -name '*.metal' -o -name '*.h' \) -print0 | xargs -0 stat -f '%m %N' 2>/dev/null | sort -rn | head -1 | awk '{print $1}')"
  OUT_MTIME="$(stat -f '%m' "$OUT")"
  if [[ -n "${NEWEST_SRC:-}" && "$OUT_MTIME" -ge "$NEWEST_SRC" ]]; then
    echo "✓ mlx.metallib up to date ($OUT)"
    exit 0
  fi
fi

echo "▶ compiling mlx Metal kernels → mlx.metallib"
echo "  kernels: $KERNELS_DIR"
# -I points at the mlx root so "#include \"mlx/backend/metal/kernels/...\"" resolves.
# Matches mlx's cmake/extension.cmake flags.
xcrun -sdk macosx metal \
  -I"$MLX_CHECKOUT" \
  -Wall -Wextra -fno-fast-math -Wno-c++17-extensions \
  "$KERNELS_DIR"/*.metal \
  -o "$OUT"

echo "✓ $(basename "$OUT")  ($(du -h "$OUT" | awk '{print $1}'))  → $OUT"
