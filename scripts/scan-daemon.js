#!/usr/bin/env node
// scan-daemon.js — idle-aware runner, launched by launchd at fixed times.
//
// launchd wakes this at (e.g.) 09:10 / 12:10 / 15:30. Instead of scanning
// immediately (and interrupting the user), it polls HID idle time every
// `--interval-sec` seconds. As soon as the user has been idle for
// `--idle-min` minutes it runs one scan-once and exits. If no idle window
// appears within `--window-min` minutes, it logs and exits without scanning.
//
// Usage:
//   node scripts/scan-daemon.js [--idle-min N] [--window-min N] [--interval-sec N]
//     --idle-min N      idle minutes required before scanning (default 5)
//     --window-min N    give up after this many minutes without an idle window (default 60)
//     --interval-sec N  poll interval in seconds (default 60)

import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { idleSeconds } from '../src/scan/scan-engine.js';
import { postStatus } from '../src/scan/push.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCAN_ONCE = join(__dirname, 'scan-once.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const cfg = { idleMin: 5, windowMin: 60, intervalSec: 60 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--idle-min') cfg.idleMin = parseFloat(argv[++i]);
    else if (a === '--window-min') cfg.windowMin = parseFloat(argv[++i]);
    else if (a === '--interval-sec') cfg.intervalSec = parseFloat(argv[++i]);
  }
  if (!Number.isFinite(cfg.idleMin)) cfg.idleMin = 5;
  if (!Number.isFinite(cfg.windowMin)) cfg.windowMin = 60;
  if (!Number.isFinite(cfg.intervalSec)) cfg.intervalSec = 60;
  return cfg;
}

function runScanOnce() {
  return new Promise((resolve) => {
    // idle already satisfied here, so tell scan-once not to re-gate.
    const child = spawn(process.execPath, [SCAN_ONCE, '--idle-min', '0'], {
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', () => resolve(1));
  });
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const idleTarget = cfg.idleMin * 60;
  const deadline = Date.now() + cfg.windowMin * 60 * 1000;
  console.error(
    `[${new Date().toISOString()}] scan-daemon 起床：等待閒置 ≥ ${cfg.idleMin} 分，` +
      `視窗 ${cfg.windowMin} 分，每 ${cfg.intervalSec}s 檢查一次。`
  );
  // 進度回報(fire-and-forget):網頁面板看得到「已接單,在等閒置」。
  void postStatus('waiting', '', `等待閒置 ≥${cfg.idleMin} 分(${cfg.windowMin} 分內有效)`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let idle = 0;
    try {
      idle = await idleSeconds();
    } catch (e) {
      console.error(`讀取閒置時間失敗：${e?.message || e}`);
    }
    if (idle >= idleTarget) {
      console.error(`[${new Date().toISOString()}] 閒置 ${Math.round(idle)}s 達標，開始掃描。`);
      const code = await runScanOnce();
      console.error(`scan-once 結束（code ${code}）。daemon 退出。`);
      process.exit(code);
    }
    if (Date.now() >= deadline) {
      console.error(
        `[${new Date().toISOString()}] 視窗 ${cfg.windowMin} 分內未等到閒置（最後閒置 ${Math.round(idle)}s），跳過本次。`
      );
      await postStatus('gaveup', '', `${cfg.windowMin} 分內沒等到你離開電腦,本次未掃`);
      process.exit(0);
    }
    await sleep(cfg.intervalSec * 1000);
  }
}

main().catch((e) => {
  console.error(`scan-daemon 失敗：${e?.message || e}`);
  process.exit(1);
});
