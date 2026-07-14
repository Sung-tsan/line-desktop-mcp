#!/usr/bin/env node
// scan-once.js — one full LINE work-chat sweep.
//
// Flow: load blocklist -> foreground LINE -> enumerate all chatrooms ->
// drop blocklisted -> read each chatroom via screenshot+OCR -> keep only NEW
// messages (deduped against last scan) -> update state -> write two artifacts:
//   1) structured JSON (for the DIKW pipeline)   -> state/out/scan-*.json
//   2) a "LINE 工作訊息日報" Markdown report      -> state/out/line-daily-*.md
//
// The cursor + frontmost app are restored on exit (even on error), so a scan
// that fires while you stepped away leaves no visible trace.
//
// Incremental: after the first successful scan a watermark (scan-meta.json) is
// kept; subsequent runs skip rooms whose sidebar timestamp predates it (minus a
// safety margin), reading only rooms that plausibly got new messages. --full
// forces a full sweep. Markers that don't parse are always scanned (fail-open).
//
// Usage:
//   node scripts/scan-once.js [--dry] [--idle-min N] [--force] [--full]
//     --dry         enumerate + print the chatroom list only; no clicks, no
//                   screenshots, no reads. Use this to build the blocklist.
//     --idle-min N  require >= N minutes of keyboard/mouse idle before scanning
//                   (default 5). Below the threshold the scan is skipped so the
//                   user is never interrupted. Ignored by --dry.
//     --force       run even if idle is below the threshold.
//     --full        force a full sweep (ignore the incremental watermark).
//     -h, --help    show this help.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ensureLineForeground,
  enumerateAllChats,
  readChatMessages,
  withFocusRestore,
  fingerprint,
  idleSeconds,
  OUT_DIR,
} from '../src/scan/scan-engine.js';
import {
  ensureDirs,
  loadBlocklist,
  applyBlocklist,
  updateSeenChats,
  diffAndRecord,
  readScanMeta,
  writeScanMeta,
  shouldSkipRoom,
} from '../src/scan/state.js';
import {
  loadDikwConfig,
  pushScan,
  enqueueOutbox,
  flushOutbox,
  postStatus,
} from '../src/scan/push.js';
import { initScanControl, isFatalAbort, ScanAbort } from '../src/scan/scan-control.js';

function parseArgs(argv) {
  const cfg = { dry: false, idleMin: 5, force: false, full: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') cfg.dry = true;
    else if (a === '--force') cfg.force = true;
    else if (a === '--full') cfg.full = true;
    else if (a === '-h' || a === '--help') cfg.help = true;
    else if (a === '--idle-min') cfg.idleMin = parseFloat(argv[++i]);
  }
  if (!Number.isFinite(cfg.idleMin)) cfg.idleMin = 5;
  return cfg;
}

const HELP = `LINE work-chat sweep (screenshot + OCR).

Usage: node scripts/scan-once.js [--dry] [--idle-min N] [--force] [--full]

  --dry         List chatrooms only (no clicks / screenshots / reads).
                Use it to pick names for the blocklist.
  --idle-min N  Require >= N minutes idle before scanning (default 5).
                Below the threshold the scan is skipped, so you are never
                interrupted mid-work. Ignored with --dry.
  --force       Skip ONLY the startup idle check. It does NOT disable the
                mid-run safety guards (abort sentinel, total/stage/scroll
                watchdog, live cursor-activity detection) — those always run.
  --full        Force a full sweep, ignoring the incremental watermark
                (scan-meta.json). Use after config/state changes or to backfill.
                Without it, rooms untouched since the last successful scan are
                skipped (unparseable timestamps are always scanned).

Safety (see README "安全機制" / scripts/scan-abort.sh):
  Abort a running scan:   scripts/scan-abort.sh   (touches state/ABORT + pkill)
  Timeouts (env overrides): SCAN_TOTAL_MS (600000) SCAN_ENUM_MS (90000)
    SCAN_CHAT_MS (30000) SCAN_SCROLL_MAX (60) SCAN_CURSOR_TOL_PX (10)
  Any of: sentinel set, a watchdog trips, or the user moves the mouse ->
  the scan restores cursor/focus, writes+pushes partial results, exits != 0.

  -h, --help    Show this help.
`;

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function toMarkdown(scan) {
  const lines = [];
  lines.push(`# LINE 工作訊息日報`);
  lines.push('');
  lines.push(`掃描時間：${scan.scannedAt}`);
  lines.push('');
  const withNew = scan.chats.filter((c) => c.newMessages.length > 0);
  if (withNew.length === 0) {
    lines.push('_本次沒有新訊息。_');
  } else {
    for (const c of withNew) {
      lines.push(`## ${c.name}${c.firstSeen ? ' 🆕' : ''}`);
      for (const m of c.newMessages) {
        const who = m.sender ? `**${m.sender}**` : '';
        const t = m.time ? ` _(${m.time})_` : '';
        const body = (m.text || '(無法解析文字，見 raw)').replace(/\n/g, ' / ');
        lines.push(`- ${who}${who ? '：' : ''}${body}${t}`);
      }
      lines.push('');
    }
  }
  const firstSeen = scan.chats.filter((c) => c.firstSeen).map((c) => c.name);
  lines.push('---');
  if (firstSeen.length) {
    lines.push(`**本次首見聊天室**：${firstSeen.join('、')}`);
    lines.push('');
    lines.push('（新聊天室預設納入掃描；若要排除，回覆把名稱加入 blocklist.json 的 excludeNames。）');
  } else {
    lines.push('**本次首見聊天室**：無');
  }
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  if (cfg.help) {
    process.stdout.write(HELP);
    return;
  }

  await ensureDirs();
  // Arm the safety spine (clears any stale ABORT sentinel from a prior aborted
  // run). Guards run in EVERY mode — including --dry, --force and the daemon.
  initScanControl();
  const blocklist = await loadBlocklist();

  // Incremental watermark. Recorded NOW (scan start, not end) so any message
  // that lands mid-scan is re-read next time. Only advanced after this scan's
  // results are safely landed (see writeScanMeta call below).
  const scanStartedAt = new Date().toISOString();
  const meta = cfg.dry ? { lastSuccessAt: null } : await readScanMeta();
  const incremental = !cfg.full && !!meta.lastSuccessAt;

  // idle gate (skip when the user is active) — never gates --dry. --force skips
  // ONLY this startup check; the mid-run guards below can never be bypassed.
  if (!cfg.dry && cfg.idleMin > 0 && !cfg.force) {
    const idle = await idleSeconds();
    if (idle < cfg.idleMin * 60) {
      console.error(
        `跳過掃描：目前閒置 ${Math.round(idle)}s < 門檻 ${cfg.idleMin * 60}s（使用者可能正在工作）。` +
          `如要強制掃描，加 --force。`
      );
      return;
    }
  }

  // 進度回報(fire-and-forget,見 push.js postStatus):讓 DIKW 網頁面板看得到
  // 「開始了/跑到哪/結束沒」。--dry 是本機建 blocklist 用,不回報。
  if (!cfg.dry) void postStatus('running', 'init', '掃描開始 · 帶 LINE 到前景');

  const result = await withFocusRestore(async () => {
    const wi = await ensureLineForeground();

    if (cfg.dry) {
      const all = await enumerateAllChats(wi);
      return { dry: true, chats: all };
    }

    // Collected incrementally so a fatal mid-run abort still yields partial
    // results (part success > losing everything).
    const chats = [];
    let enumerated = 0;
    let keptCount = 0;
    let skippedCount = 0;
    let aborted = null;
    try {
      const all = await enumerateAllChats(wi);
      enumerated = all.length;
      const names = all.map((c) => c.name);
      const firstSeen = await updateSeenChats(names);
      const kept = applyBlocklist(all, blocklist);
      keptCount = kept.length;

      // Incremental filter: drop rooms whose sidebar marker predates the
      // watermark (minus safety margin). Never skip a first-seen room (no prior
      // read to trust) or an unparseable marker (shouldSkipRoom fails open).
      const now = new Date();
      const toRead = [];
      const skippedNames = [];
      for (const chat of kept) {
        if (incremental && !firstSeen.has(chat.name) && shouldSkipRoom(chat.marker, meta.lastSuccessAt, now)) {
          skippedNames.push(chat.name);
        } else {
          toRead.push(chat);
        }
      }
      skippedCount = skippedNames.length;
      const modeLabel = incremental ? `增量·略過 ${skippedCount}/${keptCount} 室` : '全掃';
      if (skippedNames.length) {
        process.stderr.write(`[scan] 增量略過 ${skippedCount} 室（marker 早於上次掃描）：${skippedNames.slice(0, 12).join('、')}${skippedNames.length > 12 ? ' …' : ''}\n`);
      }
      void postStatus('running', 'read', `列舉 ${all.length} 室 · ${modeLabel} · 讀 ${toRead.length} 室中`);

      let i = 0;
      for (const chat of toRead) {
        i += 1;
        let newMessages = [];
        let error = null;
        try {
          const msgs = await readChatMessages(chat, wi);
          const withFp = msgs.map((m) => ({ ...m, fp: fingerprint(m) }));
          const fresh = await diffAndRecord(chat.name, withFp);
          newMessages = fresh.map(({ fp, ...m }) => m);
          process.stderr.write(`[scan] read ${i}/${toRead.length} ${chat.name}: +${newMessages.length}\n`);
        } catch (e) {
          // A fatal abort (sentinel / total timeout / user activity) must unwind
          // the whole sweep — do NOT swallow it as a per-chat error.
          if (isFatalAbort(e)) throw e;
          error = e?.message || String(e);
          process.stderr.write(`[scan] read ${i}/${toRead.length} ${chat.name}: skipped (${error})\n`);
        }
        chats.push({
          name: chat.name,
          firstSeen: firstSeen.has(chat.name),
          newMessages,
          ...(error ? { error } : {}),
        });
      }
    } catch (e) {
      if (!(e instanceof ScanAbort)) throw e; // real bug -> propagate
      aborted = { reason: e.reason, phase: e.phase };
    }
    return { dry: false, chats, enumerated, scanned: chats.length, kept: keptCount, skipped: skippedCount, incremental, aborted };
  });

  if (result.dry) {
    console.log(`偵測到 ${result.chats.length} 個聊天室（--dry，未讀取內容）：`);
    for (const c of result.chats) console.log(`  - ${c.name}`);
    return;
  }

  // Write + push partial results even on abort (part success > total loss).
  const scan = { scannedAt: new Date().toISOString(), chats: result.chats };
  if (result.aborted) scan.aborted = result.aborted;
  const stamp = ts();
  const jsonPath = join(OUT_DIR, `scan-${stamp}.json`);
  const mdPath = join(OUT_DIR, `line-daily-${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(scan, null, 2) + '\n', 'utf8');
  await writeFile(mdPath, toMarkdown(scan), 'utf8');

  const totalNew = scan.chats.reduce((s, c) => s + c.newMessages.length, 0);
  const modeSummary = result.incremental ? `增量略過 ${result.skipped}/${result.kept} 室` : '全掃';
  if (result.aborted) {
    const { reason, phase } = result.aborted;
    console.error(
      `⚠ watchdog 中止於階段「${phase}」（原因：${reason}）。已還原游標/焦點，` +
        `保留部分結果：列舉 ${result.enumerated} 室、${modeSummary}、已讀 ${result.scanned} 室、新訊息 ${totalNew} 則。`
    );
  } else {
    console.error(
      `掃描完成：列舉 ${result.enumerated} 室、${modeSummary}、讀取 ${result.scanned} 室、新訊息 ${totalNew} 則。`
    );
  }
  console.error(`  JSON: ${jsonPath}`);
  console.error(`  日報: ${mdPath}`);

  const push = await pushToDikw(scan, jsonPath, totalNew);

  // Advance the watermark ONLY when this scan fully completed (no abort) AND its
  // results are safely landed (push ok, or genuinely nothing to push). A failed
  // push (queued to outbox) or an abort leaves the watermark, so next run
  // re-reads more rooms — rather re-scan than miss.
  if (!result.aborted && push.advance) {
    await writeScanMeta({ lastSuccessAt: scanStartedAt });
    console.error(`  增量水位已更新：lastSuccessAt=${scanStartedAt}`);
  }

  const doneDetail = `列舉 ${result.enumerated} 室 · ${modeSummary} · 讀 ${result.scanned} 室 · 新訊息 ${totalNew} 則`;
  if (result.aborted) {
    await postStatus('aborted', result.aborted.phase, `原因:${result.aborted.reason} · 部分結果:${modeSummary}·讀${result.scanned}·新訊息${totalNew}`, push.counts);
  } else {
    await postStatus('done', '', doneDetail, push.counts);
  }

  // A watchdog/abort stop must surface as a non-zero exit (part results still saved).
  if (result.aborted) process.exitCode = 1;
}

/**
 * Push the finished scan to the DIKW ingest API (best-effort). Always flushes
 * the outbox first so retries stay in order ahead of the newest scan. Never
 * throws -- a push failure must not fail the scan itself.
 *
 * @returns {Promise<{advance:boolean, counts:{received,written,deduped}|null}>}
 *   advance=true means results are safely landed and the incremental watermark
 *   may move forward; false means keep it (unconfigured / failed / queued).
 */
async function pushToDikw(scan, jsonPath, totalNew) {
  try {
    const config = await loadDikwConfig();
    if (!config) return { advance: false, counts: null }; // unconfigured -> stay full-scan

    await flushOutbox(config);

    if (totalNew === 0) {
      // A clean scan that found nothing new IS a success: everything read is
      // current, so the watermark may advance (quiet-day rooms get skipped next).
      console.error('DIKW 推送：本次無新訊息，略過推送。');
      return { advance: true, counts: { received: 0, written: 0, deduped: 0 } };
    }

    const result = await pushScan(scan, config);
    if (result.status === 'ok') {
      console.error(
        `DIKW 推送成功：received=${result.body?.received} written=${result.body?.written} deduped=${result.body?.deduped}`
      );
      return {
        advance: true,
        counts: {
          received: result.body?.received ?? null,
          written: result.body?.written ?? null,
          deduped: result.body?.deduped ?? null,
        },
      };
    } else if (result.status === 'auth' || result.status === 'bad_request') {
      console.error(
        `DIKW 推送失敗且不可重試（HTTP ${result.httpStatus} ${result.message}），不進 outbox，請人工檢查設定/payload。`
      );
      return { advance: false, counts: null };
    } else {
      console.error(`DIKW 推送失敗：${result.message}，加入 outbox 待下次掃描補推。`);
      await enqueueOutbox(jsonPath);
      return { advance: false, counts: null };
    }
  } catch (e) {
    // The scan itself already succeeded and is on disk; a bug in the push
    // subsystem must never make scan-once.js report failure.
    console.error(`DIKW 推送：內部錯誤（已略過，掃描結果不受影響）：${e?.message || e}`);
    return { advance: false, counts: null };
  }
}

main().catch(async (e) => {
  console.error(`scan-once 失敗：${e?.message || e}`);
  await postStatus('aborted', '', `掃描失敗:${String(e?.message || e).slice(0, 150)}`);
  process.exitCode = 1;
});
