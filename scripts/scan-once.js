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
// Usage:
//   node scripts/scan-once.js [--dry] [--idle-min N] [--force]
//     --dry         enumerate + print the chatroom list only; no clicks, no
//                   screenshots, no reads. Use this to build the blocklist.
//     --idle-min N  require >= N minutes of keyboard/mouse idle before scanning
//                   (default 5). Below the threshold the scan is skipped so the
//                   user is never interrupted. Ignored by --dry.
//     --force       run even if idle is below the threshold.
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
} from '../src/scan/state.js';

function parseArgs(argv) {
  const cfg = { dry: false, idleMin: 5, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') cfg.dry = true;
    else if (a === '--force') cfg.force = true;
    else if (a === '-h' || a === '--help') cfg.help = true;
    else if (a === '--idle-min') cfg.idleMin = parseFloat(argv[++i]);
  }
  if (!Number.isFinite(cfg.idleMin)) cfg.idleMin = 5;
  return cfg;
}

const HELP = `LINE work-chat sweep (screenshot + OCR).

Usage: node scripts/scan-once.js [--dry] [--idle-min N] [--force]

  --dry         List chatrooms only (no clicks / screenshots / reads).
                Use it to pick names for the blocklist.
  --idle-min N  Require >= N minutes idle before scanning (default 5).
                Below the threshold the scan is skipped, so you are never
                interrupted mid-work. Ignored with --dry.
  --force       Scan even if idle is below the threshold.
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
  const blocklist = await loadBlocklist();

  // idle gate (skip when the user is active) — never gates --dry.
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

  const result = await withFocusRestore(async () => {
    const wi = await ensureLineForeground();

    if (cfg.dry) {
      const all = await enumerateAllChats(wi);
      return { dry: true, chats: all };
    }

    const all = await enumerateAllChats(wi);
    const names = all.map((c) => c.name);
    const firstSeen = await updateSeenChats(names);
    const kept = applyBlocklist(all, blocklist);

    const chats = [];
    for (const chat of kept) {
      let newMessages = [];
      let error = null;
      try {
        const msgs = await readChatMessages(chat, wi);
        const withFp = msgs.map((m) => ({ ...m, fp: fingerprint(m) }));
        const fresh = await diffAndRecord(chat.name, withFp);
        newMessages = fresh.map(({ fp, ...m }) => m);
      } catch (e) {
        error = e?.message || String(e);
      }
      chats.push({
        name: chat.name,
        firstSeen: firstSeen.has(chat.name),
        newMessages,
        ...(error ? { error } : {}),
      });
    }
    return { dry: false, chats, enumerated: names.length, scanned: kept.length };
  });

  if (result.dry) {
    console.log(`偵測到 ${result.chats.length} 個聊天室（--dry，未讀取內容）：`);
    for (const c of result.chats) console.log(`  - ${c.name}`);
    return;
  }

  const scan = { scannedAt: new Date().toISOString(), chats: result.chats };
  const stamp = ts();
  const jsonPath = join(OUT_DIR, `scan-${stamp}.json`);
  const mdPath = join(OUT_DIR, `line-daily-${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(scan, null, 2) + '\n', 'utf8');
  await writeFile(mdPath, toMarkdown(scan), 'utf8');

  const totalNew = scan.chats.reduce((s, c) => s + c.newMessages.length, 0);
  console.error(
    `掃描完成：列舉 ${result.enumerated} 室、讀取 ${result.scanned} 室、新訊息 ${totalNew} 則。`
  );
  console.error(`  JSON: ${jsonPath}`);
  console.error(`  日報: ${mdPath}`);
}

main().catch((e) => {
  console.error(`scan-once 失敗：${e?.message || e}`);
  process.exitCode = 1;
});
