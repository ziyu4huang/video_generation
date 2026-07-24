#!/usr/bin/env bash
#
# setup-metallib.sh — copy MLX's precompiled Metal kernels next to the Swift
# executable so `swift run` / `.build/debug/zimage` can use the GPU.
#
# Why: SwiftPM cannot compile Metal shaders (needs Xcode). The Python venv's
# `mlx` package already ships a compatible `mlx.metallib` — we reuse it.
#
# Usage:
#   ./scripts/setup-metallib.sh        # default: debug
#   ./scripts/setup-metallib.sh release
#
set -euo pipefail

cd "$(dirname "$0")/.."

CONFIG="${1:-debug}"
VENV_METALLIB="../../../video_generation__venv/lib/python3.13/site-packages/mlx/lib/mlx.metallib"

if [ ! -f "$VENV_METALLIB" ]; then
	echo "error: metallib not found at $VENV_METALLIB" >&2
	echo "       is the Python mlx venv set up? (python/venv/bin/pip install mlx)" >&2
	exit 1
fi

# Copy to every executable-holding build dir matching the config.
DESTS=$(find .build -type d -name "$CONFIG" 2>/dev/null || true)
if [ -z "$DESTS" ]; then
	echo "no .build/*/$CONFIG directory yet — run 'swift build -c $CONFIG' first"
	exit 1
fi

for d in $DESTS; do
	cp "$VENV_METALLIB" "$d/mlx.metallib"
	echo "copied mlx.metallib → $d/mlx.metallib"
done

# `swift test` runs from inside the .xctest bundle's own MacOS dir, not the
# config dir directly — needs its own copy.
XCTEST_DESTS=$(find .build -type d -iname "*PackageTests.xctest" 2>/dev/null || true)
for d in $XCTEST_DESTS; do
	cp "$VENV_METALLIB" "$d/Contents/MacOS/mlx.metallib"
	echo "copied mlx.metallib → $d/Contents/MacOS/mlx.metallib"
done
