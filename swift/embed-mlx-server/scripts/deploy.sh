#!/bin/bash
# deploy.sh — build embed-mlx-server in release mode and install it to
# ~/proj/dist/embed-server/, the fixed path the launchd plist points at.
# Decoupled from swift/embed-mlx-server/.build/ on purpose: `swift build`
# or `swift package clean` must never break the already-running service.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"
DIST_DIR="$HOME/proj/dist/embed-server"
VENV_METALLIB="$PACKAGE_DIR/../../../video_generation__venv/lib/python3.13/site-packages/mlx/lib/mlx.metallib"

echo "Building embed-mlx-server (release)..."
( cd "$PACKAGE_DIR" && swift build -c release --product embed-mlx-server )

mkdir -p "$DIST_DIR"
cp "$PACKAGE_DIR/.build/release/embed-mlx-server" "$DIST_DIR/embed-mlx-server"

# MLX looks for mlx.metallib colocated with the running binary (SwiftPM
# can't compile Metal shaders itself — see scripts/setup-metallib.sh, which
# does the same thing for local .build/ runs). The deployed binary needs
# its own copy for the same reason, or the launchd-run service crashes at
# startup with "Failed to load the default metallib".
if [ ! -f "$VENV_METALLIB" ]; then
    echo "error: metallib not found at $VENV_METALLIB" >&2
    echo "       is the Python mlx venv set up? (python/venv/bin/pip install mlx)" >&2
    exit 1
fi
cp "$VENV_METALLIB" "$DIST_DIR/mlx.metallib"

echo "Deployed to $DIST_DIR/embed-mlx-server (+ mlx.metallib)"
echo "Restart the service to pick up the new binary:"
echo "  $SCRIPT_DIR/embed-mlx-server-service.sh restart"
