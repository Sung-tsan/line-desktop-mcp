#!/usr/bin/env bash
# scan-abort.sh — stop a running LINE scan RIGHT NOW.
#
# Two layers:
#   1. Touch the abort sentinel (src/scan/state/ABORT). The scan checks it before
#      every screenshot / click / scroll and stops at the next checkpoint,
#      restoring the cursor + frontmost app and writing whatever it already read.
#   2. pkill fallback — if a process is somehow wedged past the sentinel check,
#      hard-kill it after a short grace period.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SENTINEL="$DIR/src/scan/state/ABORT"

mkdir -p "$(dirname "$SENTINEL")"
printf '%s manual abort via scan-abort.sh\n' "$(date -u +%FT%TZ)" > "$SENTINEL"
echo "已建立中止哨兵：$SENTINEL"
echo "掃描將在下一個檢查點停止並還原游標/焦點（通常 <1s）。"

# Grace period for the graceful stop, then pkill anything still alive.
sleep 3
if pgrep -f 'scan-once\.js|scan-daemon\.js' >/dev/null 2>&1; then
  echo "仍偵測到掃描程序，pkill 收尾…"
  pkill -f 'scan-once\.js' 2>/dev/null || true
  pkill -f 'scan-daemon\.js' 2>/dev/null || true
  echo "（pkill fallback：程序若在 pkill 前被殺，游標已由 graceful 路徑還原；"
  echo "  若由 pkill 殺掉，請手動移動一下滑鼠即可，LINE 仍在前景。）"
else
  echo "沒有殘留掃描程序。完成。"
fi

# The sentinel is auto-cleared by the next scan startup (initScanControl); leave it.
