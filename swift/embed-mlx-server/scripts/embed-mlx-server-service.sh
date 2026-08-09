#!/bin/bash
# Thin launchctl wrapper around the manually-installed
# ~/Library/LaunchAgents/com.video-generation.embed-mlx-server.plist LaunchAgent.
set -euo pipefail

LABEL="com.video-generation.embed-mlx-server"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"
TARGET="${DOMAIN}/${LABEL}"
LOG_FILE="$HOME/proj/dist/embed-server/embed-mlx-server.log"

usage() {
    cat <<EOF
Usage: $(basename "$0") <start|stop|restart|status|log>

Manages the embed-mlx-server LaunchAgent ($PLIST) via launchctl.
EOF
}

require_plist() {
    if [[ ! -f "$PLIST" ]]; then
        echo "Error: $PLIST not found. Copy scripts/com.video-generation.embed-mlx-server.plist there first." >&2
        echo "       See swift/embed-mlx-server/README.md — the plist hardcodes absolute paths." >&2
        exit 1
    fi
}

is_loaded() {
    launchctl print "$TARGET" >/dev/null 2>&1
}

case "${1:-}" in
    start)
        require_plist
        if is_loaded; then
            echo "$LABEL already loaded"
        else
            launchctl bootstrap "$DOMAIN" "$PLIST"
            echo "Started $LABEL"
        fi
        ;;
    stop)
        if is_loaded; then
            launchctl bootout "$TARGET"
            echo "Stopped $LABEL"
        else
            echo "$LABEL not loaded"
        fi
        ;;
    restart)
        require_plist
        if is_loaded; then
            launchctl kickstart -k "$TARGET"
        else
            launchctl bootstrap "$DOMAIN" "$PLIST"
        fi
        echo "Restarted $LABEL"
        ;;
    status)
        if is_loaded; then
            # `|| true`: under `set -e` a non-matching grep would exit 1 with no
            # output, making `status` look like it failed rather than reporting.
            launchctl print "$TARGET" | grep -E "state = |pid = " || \
                echo "(loaded, but no state/pid lines — see: launchctl print $TARGET)"
        else
            echo "Not loaded"
        fi
        ;;
    log)
        if [[ ! -f "$LOG_FILE" ]]; then
            echo "No log yet at $LOG_FILE — has the service been started?" >&2
            exit 1
        fi
        tail -n "${2:-50}" -f "$LOG_FILE"
        ;;
    *)
        usage
        exit 1
        ;;
esac
