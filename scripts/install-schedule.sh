#!/bin/bash
# install-schedule.sh — install / remove the LINE scan launchd agents.
#
# Usage:
#   scripts/install-schedule.sh install    # fill templates, load into launchd
#   scripts/install-schedule.sh uninstall  # unload + remove installed plists
#   scripts/install-schedule.sh status     # show whether they're loaded
#
# Two agents, both templated under native/launchd/ and installed to
# ~/Library/LaunchAgents/ with __NODE__/__DAEMON__/__LOG__/__WORKDIR__ filled in:
#   cc.linescan         3x/day schedule (09:10/12:10/15:30), idle gate 5 min
#   cc.linescan.manual  no schedule; fire on demand ("water-break" button):
#                         launchctl kickstart gui/$(id -u)/cc.linescan.manual
#                       idle gate 1 min, gives up after 20 min.
#
# IMPORTANT: the node binary launchd runs needs its OWN Screen Recording
# permission (System Settings > Privacy & Security > Screen Recording). Granting
# it to your terminal does not cover the launchd-spawned process.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABELS=("cc.linescan" "cc.linescan.manual")
LOG="$HOME/Library/Logs/cc.linescan.log" # both agents share one log

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
    for LABEL in "${LABELS[@]}"; do
      TEMPLATE="$REPO/native/launchd/$LABEL.plist"
      INSTALLED="$HOME/Library/LaunchAgents/$LABEL.plist"
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
    done
    echo "node:   $NODE"
    echo "daemon: $DAEMON"
    echo "log:    $LOG"
    echo
    echo "Manual trigger: launchctl kickstart gui/$(id -u)/cc.linescan.manual"
    echo "Reminder: grant Screen Recording permission to '$NODE' (or its wrapper)"
    echo "under System Settings > Privacy & Security > Screen Recording."
    ;;
  uninstall)
    for LABEL in "${LABELS[@]}"; do
      INSTALLED="$HOME/Library/LaunchAgents/$LABEL.plist"
      launchctl unload "$INSTALLED" 2>/dev/null || true
      rm -f "$INSTALLED"
      echo "uninstalled: $INSTALLED"
    done
    ;;
  status)
    for LABEL in "${LABELS[@]}"; do
      # launchctl print 直查 label;不能用 `launchctl list | grep -q`(pipefail 下 grep -q 提早退出
      # 造成 SIGPIPE 假陰性,已載入也顯示 not loaded)。
      if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
        echo "loaded: $LABEL"
      else
        echo "not loaded: $LABEL"
      fi
      INSTALLED="$HOME/Library/LaunchAgents/$LABEL.plist"
      [ -f "$INSTALLED" ] && echo "  installed plist: $INSTALLED" || echo "  no installed plist"
    done
    ;;
  *)
    echo "usage: $0 {install|uninstall|status}" >&2
    exit 64
    ;;
esac
