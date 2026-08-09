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

# Validate every input BEFORE touching $DIST_DIR. A failure partway through
# would otherwise leave a half-updated deploy target (new binary, stale or
# missing metallib), which is exactly the "broken running service" this
# script's separation from .build/ exists to prevent.
#
# MLX looks for mlx.metallib colocated with the running binary (SwiftPM
# can't compile Metal shaders itself — see scripts/setup-metallib.sh, which
# does the same thing for local .build/ runs). The deployed binary needs
# its own copy for the same reason, or the launchd-run service crashes at
# startup with "Failed to load the default metallib".
if [ ! -f "$VENV_METALLIB" ]; then
    echo "error: metallib not found at $VENV_METALLIB" >&2
    echo "       is the mlx venv set up? (see scripts/setup-offline.sh, or" >&2
    echo "       'uv pip install mlx' into ../../../video_generation__venv)" >&2
    exit 1
fi

echo "Building embed-mlx-server (release)..."
( cd "$PACKAGE_DIR" && swift build -c release --product embed-mlx-server )

mkdir -p "$DIST_DIR"

# Copy to a temp name then mv into place: mv within one filesystem is atomic
# and swaps the directory entry, so a currently-RUNNING service keeps its old
# inode and is never handed a half-written executable.
# `cp` already carries the source's mode bits over to the new temp file, so
# the binary stays executable and the metallib stays plain data.
install_atomically() {
    local src="$1" dest="$2"
    cp "$src" "$dest.tmp"
    mv -f "$dest.tmp" "$dest"
}

install_atomically "$PACKAGE_DIR/.build/release/embed-mlx-server" "$DIST_DIR/embed-mlx-server"
install_atomically "$VENV_METALLIB" "$DIST_DIR/mlx.metallib"

echo "Deployed to $DIST_DIR/embed-mlx-server (+ mlx.metallib)"
echo "Restart the service to pick up the new binary:"
echo "  $SCRIPT_DIR/embed-mlx-server-service.sh restart"
