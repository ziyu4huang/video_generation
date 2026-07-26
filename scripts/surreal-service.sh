#!/bin/bash
# Thin launchctl wrapper around the manually-installed
# ~/Library/LaunchAgents/com.surrealdb.surreal.plist LaunchAgent.
#
# This is deliberately NOT `brew services start/stop surreal`: the
# `surrealdb/homebrew-tap` formula's built-in service block runs SurrealDB
# against a `file://` storage engine, which is incompatible with the
# `rocksdb:` engine this LaunchAgent uses. Running `brew services start`
# would regenerate the plist with the formula's defaults and point at an
# empty/incompatible database. See scripts/run_surreal.README.md.

set -euo pipefail

LABEL="com.surrealdb.surreal"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"
TARGET="${DOMAIN}/${LABEL}"
LOG_FILE="/opt/homebrew/var/log/surreal.log"

usage() {
    cat <<EOF
Usage: $(basename "$0") <start|stop|restart|status|log>

Manages the SurrealDB LaunchAgent ($PLIST) via launchctl.
EOF
}

require_plist() {
    if [[ ! -f "$PLIST" ]]; then
        echo "Error: $PLIST not found. See scripts/run_surreal.README.md." >&2
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
