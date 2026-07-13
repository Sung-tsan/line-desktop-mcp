#!/usr/bin/env node
// scan-bridge.js — cloud-to-Mac trigger bridge, run by launchd every 60s.
//
// The DIKW web cockpit can't reach this Mac directly, so the web "掃描 LINE"
// button just files a request (Notion config via /api/line-scan). This one-shot
// script polls that endpoint; when a request is pending it claims it and
// kickstarts the local cc.linescan.manual launchd agent (idle-gated scan).
//
// Design constraints:
//   - one-shot + silent when idle: launchd StartInterval respawns us every 60s
//     and stdout goes to the shared cc.linescan.log — print NOTHING unless we
//     actually act, so the log stays readable.
//   - never overlap a running scan: if scan-daemon/scan-once is already alive
//     we still claim (the in-flight run's status covers the user's intent) but
//     skip the kickstart.
//   - auth reuses the same LINE_INGEST_SECRET config as pushing (state/dikw.json).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { loadDikwConfig } from '../src/scan/push.js';

const pExecFile = promisify(execFile);

async function scanProcessAlive() {
  try {
    // pattern anchored on script filenames; this process is scan-bridge so no self-match.
    await pExecFile('/usr/bin/pgrep', ['-f', 'scripts/scan-(daemon|once)\\.js']);
    return true;
  } catch {
    return false; // pgrep exits 1 when no match
  }
}

async function main() {
  const config = await loadDikwConfig();
  if (!config) return; // not configured -> nothing to poll (loadDikwConfig logged once)

  const headers = { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' };
  let request = null;
  try {
    const r = await fetch(`${config.url}/api/line-scan?op=pending`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return; // transient server/auth issue -> next minute retries
    request = (await r.json())?.request ?? null;
  } catch {
    return; // network blip -> silent, next minute retries
  }
  if (!request) return; // nothing pending (the common case) -> stay silent

  console.error(`[${new Date().toISOString()}] scan-bridge 接單:${request.requestedBy || '?'} @ ${request.at || '?'}`);
  try {
    await fetch(`${config.url}/api/line-scan`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ op: 'claim' }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    console.error('scan-bridge:claim 失敗(網路),下一分鐘重試。');
    return; // claim failed -> leave the request for the next tick
  }

  if (await scanProcessAlive()) {
    console.error('scan-bridge:已有掃描在等待/執行,不重複啟動(本請求由進行中的掃描涵蓋)。');
    return;
  }
  try {
    await pExecFile('/bin/launchctl', ['kickstart', `gui/${process.getuid()}/cc.linescan.manual`]);
    console.error('scan-bridge:已 kickstart cc.linescan.manual(閒置 ≥1 分即掃)。');
  } catch (e) {
    console.error(`scan-bridge:kickstart 失敗:${e?.message || e}(cc.linescan.manual 未安裝?跑 install-schedule.sh install)`);
  }
}

main().catch((e) => {
  console.error(`scan-bridge 失敗:${e?.message || e}`);
  process.exitCode = 1;
});
