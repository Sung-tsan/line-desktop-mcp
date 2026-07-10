#!/usr/bin/env node
// scripts/probe-ax.js
//
// P3 calibration probe. Dumps the LINE Desktop macOS Accessibility (AX) tree so
// the candidate paths in src/automation/macos-line-automation.js can be verified
// / adjusted after Accessibility permission is granted and a LINE window is open.
//
// Usage:
//   node scripts/probe-ax.js                # dump the whole LINE window (depth<=8)
//   node scripts/probe-ax.js --messages     # dump only the message-area subtree
//   node scripts/probe-ax.js --depth 10     # override max depth
//   node scripts/probe-ax.js --lines 800    # override max output lines
//
// It prints an ACTIONABLE message (not a raw stack trace) when permission is
// missing, LINE isn't running, or LINE has no open window.

import { MacOSLineAutomation, osa } from '../src/automation/macos-line-automation.js';

function parseArgs(argv) {
  const opts = { messagesOnly: false, maxDepth: 8, maxLines: 500 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--messages') opts.messagesOnly = true;
    else if (a === '--depth' && argv[i + 1]) { opts.maxDepth = parseInt(argv[++i], 10) || opts.maxDepth; }
    else if (a === '--lines' && argv[i + 1]) { opts.maxLines = parseInt(argv[++i], 10) || opts.maxLines; }
    else if (a === '--help' || a === '-h') { opts.help = true; }
  }
  return opts;
}

function printHelp() {
  console.log(`probe-ax — dump LINE Desktop AX tree for candidate-path calibration

  node scripts/probe-ax.js               dump whole LINE window (depth<=8, <=500 lines)
  node scripts/probe-ax.js --messages    dump only the currently-open chat's message area
  node scripts/probe-ax.js --depth N     max recursion depth
  node scripts/probe-ax.js --lines N     max output lines

Output columns per element:  <indent>role | name/description | value(<=40 chars)`);
}

async function preconditionCheck(mac) {
  // 1) Accessibility permission
  let permEnabled = false;
  try {
    const r = await osa('tell application "System Events" to return UI elements enabled', { timeoutMs: 5000 });
    permEnabled = String(r) === 'true';
  } catch (e) {
    // fall through to the generic permission hint below
  }
  if (!permEnabled) {
    return {
      ok: false,
      msg:
        '無法存取 Accessibility（輔助使用）權限。\n' +
        '請到「系統設定 › 隱私權與安全性 › 輔助使用」，把執行本程式的終端機（Terminal / iTerm）\n' +
        '或 Node 執行檔加入清單並打勾，然後重新執行本探測器。',
    };
  }

  // 2) LINE running?
  const running = await mac.isLineRunning();
  if (!running) {
    return { ok: false, msg: 'LINE 未啟動：請先開啟 LINE Desktop 應用程式，再重新執行本探測器。' };
  }

  // 3) LINE has a window?
  try {
    const c = await osa('tell application "System Events" to tell process "LINE" to return (count of windows)', {
      timeoutMs: 6000,
    });
    if (parseInt(c, 10) === 0) {
      return {
        ok: false,
        msg:
          'LINE 正在執行但沒有開啟的視窗（可能被最小化或關到選單列）。\n' +
          '請點開 LINE 主視窗（若要 dump 訊息區 --messages，請先在 LINE 內開好目標聊天室），再重試。',
      };
    }
  } catch (e) {
    return { ok: false, msg: `檢查 LINE 視窗時發生錯誤：${e?.message || e}` };
  }

  return { ok: true };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  if (process.platform !== 'darwin') {
    console.error('probe-ax 僅支援 macOS（此腳本用於校準 macOS AX 路徑）。');
    process.exit(1);
  }

  const mac = new MacOSLineAutomation();

  const pre = await preconditionCheck(mac);
  if (!pre.ok) {
    console.error(pre.msg);
    process.exit(1);
  }

  try {
    const dump = await mac.dumpAXTree({
      maxDepth: opts.maxDepth,
      maxLines: opts.maxLines,
      messagesOnly: opts.messagesOnly,
    });
    process.stdout.write(dump.endsWith('\n') ? dump : dump + '\n');
    console.error(
      `\n[probe-ax] mode=${opts.messagesOnly ? 'messages' : 'window'} depth<=${opts.maxDepth} lines<=${opts.maxLines}`
    );
  } catch (e) {
    const m = e?.message || String(e);
    if (m.includes('NOPROC')) console.error('LINE 未啟動：請先開啟 LINE Desktop。');
    else if (m.includes('NOWIN')) console.error('LINE 沒有開啟的視窗：請點開 LINE 主視窗後重試。');
    else if (m.includes('ROOT_NOT_FOUND'))
      console.error('找不到起始節點（訊息區候選路徑皆未命中）：請先在 LINE 開好聊天室，或改用不加 --messages 的整窗 dump。');
    else console.error(`探測失敗：${m}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`探測器未預期錯誤：${e?.message || e}`);
  process.exit(1);
});
