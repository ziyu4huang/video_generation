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
            launchctl print "$TARGET" | grep -E "state = |pid = "
        else
            echo "Not loaded"
        fi
        ;;
    log)
        tail -n "${2:-50}" -f "$LOG_FILE"
        ;;
    *)
        usage
        exit 1
        ;;
esac
