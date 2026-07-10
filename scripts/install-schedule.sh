#!/bin/bash
# install-schedule.sh — install / remove the idle-aware LINE scan launchd agent.
#
# Usage:
#   scripts/install-schedule.sh install    # fill template, load into launchd
#   scripts/install-schedule.sh uninstall  # unload + remove installed plist
#   scripts/install-schedule.sh status     # show whether it's loaded
#
# The template lives at native/launchd/cc.linescan.plist. This script fills the
# __NODE__ / __DAEMON__ / __LOG__ / __WORKDIR__ placeholders with absolute paths
# and installs a concrete copy to ~/Library/LaunchAgents/cc.linescan.plist.
#
# IMPORTANT: the node binary launchd runs needs its OWN Screen Recording
# permission (System Settings > Privacy & Security > Screen Recording). Granting
# it to your terminal does not cover the launchd-spawned process.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$REPO/native/launchd/cc.linescan.plist"
LABEL="cc.linescan"
INSTALLED="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/$LABEL.log"

resolve_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return; fi
  for c in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  echo "ERROR: node not found in PATH." >&2
  exit 1
}

cmd="${1:-status}"
case "$cmd" in
  install)
    NODE="$(resolve_node)"
    DAEMON="$REPO/scripts/scan-daemon.js"
    mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$LOG")"
    sed \
      -e "s#__NODE__#$NODE#g" \
      -e "s#__DAEMON__#$DAEMON#g" \
      -e "s#__WORKDIR__#$REPO#g" \
      -e "s#__LOG__#$LOG#g" \
      "$TEMPLATE" > "$INSTALLED"
    # reload if already present
    launchctl unload "$INSTALLED" 2>/dev/null || true
    launchctl load "$INSTALLED"
    echo "installed + loaded: $INSTALLED"
    echo "node:   $NODE"
    echo "daemon: $DAEMON"
    echo "log:    $LOG"
    echo
    echo "Reminder: grant Screen Recording permission to '$NODE' (or its wrapper)"
    echo "under System Settings > Privacy & Security > Screen Recording."
    ;;
  uninstall)
    launchctl unload "$INSTALLED" 2>/dev/null || true
    rm -f "$INSTALLED"
    echo "uninstalled: $INSTALLED"
    ;;
  status)
    if launchctl list | grep -q "$LABEL"; then
      echo "loaded: $LABEL"
    else
      echo "not loaded: $LABEL"
    fi
    [ -f "$INSTALLED" ] && echo "installed plist: $INSTALLED" || echo "no installed plist"
    ;;
  *)
    echo "usage: $0 {install|uninstall|status}" >&2
    exit 64
    ;;
esac
