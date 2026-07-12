-- 掃描LINE.app — 手動觸發 LINE 掃描的桌面按鈕。
-- 站起來去裝水前按一下:kickstart cc.linescan.manual(閒置 ≥1 分鐘才真的動手,
-- 20 分鐘內沒等到閒置就放棄)。掃描中回座會被游標偵測安全中止並還原。
-- 重新編譯:osacompile -o ~/Desktop/掃描LINE.app native/launchd/scan-button.applescript
on run
	set alreadyRunning to "no"
	try
		set alreadyRunning to do shell script "/usr/bin/pgrep -f 'scripts/scan-(daemon|once)\\.js' >/dev/null && echo yes || echo no"
	end try
	if alreadyRunning is "yes" then
		display notification "已有掃描在等待或執行中,不重複觸發" with title "LINE 掃描"
		return
	end if
	try
		do shell script "/bin/launchctl kickstart gui/$(id -u)/cc.linescan.manual"
		display notification "已排入:離開電腦約 1 分鐘後自動開始(20 分鐘內有效)" with title "LINE 掃描"
	on error
		display notification "cc.linescan.manual 尚未安裝 — 請先跑 scripts/install-schedule.sh install" with title "LINE 掃描"
	end try
end run
