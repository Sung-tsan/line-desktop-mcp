// scan-engine.js
//
// Screenshot + Apple Vision OCR reader for LINE Desktop (macOS).
//
// Why this exists (hard facts established by live testing — do not "optimize" away):
//   1. This LINE build self-draws message text; it never lands in the macOS
//      Accessibility tree (AXStaticText AXValue is empty). So AX cannot read text.
//   2. LINE drops its onscreen window ~1s after losing focus. So background
//      screenshots are impossible — LINE must be foreground while we capture.
//   3. The only working read path is: foreground screenshot -> Apple Vision OCR
//      (great Traditional-Chinese accuracy, zero LLM tokens).
//   4. Switching chats: AXPress / set-selected do nothing on sidebar rows (LINE
//      wires no AX action). The only thing that works is a real click (cliclick)
//      at the row's screen coordinates.
//   5. "Don't interrupt the user": callers gate on HID idle time and this engine
//      snapshots the cursor + frontmost app on entry and restores them on exit
//      (including on error), so a scan that fires while the user stepped away
//      leaves no trace when they come back.
//
// All file paths are derived from import.meta.url (NOT os.homedir), because this
// is meant to be driven by launchd, whose cwd/HOME differ from an interactive run.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlink } from 'node:fs/promises';

import { osa } from '../automation/macos-line-automation.js';
import { getScanControl } from './scan-control.js';

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const __dirname = dirname(fileURLToPath(import.meta.url));
const NATIVE_DIR = resolve(__dirname, '../../native');
const OCR_BIN = join(NATIVE_DIR, 'ocr');
const WINID_BIN = join(NATIVE_DIR, 'winid');
const SCROLL_BIN = join(NATIVE_DIR, 'scroll');

export const STATE_DIR = join(__dirname, 'state');
export const OUT_DIR = join(STATE_DIR, 'out');

// UI chrome strings that appear in the sidebar but are not chatrooms.
const SIDEBAR_UI_WORDS = new Set([
  '全部', '好友', '群組', '社群', '官方帳號', '服務',
  '搜尋聊天和訊息', '搜尋', '輸入訊息', 'LINE VOOM', '錢包', '主頁',
]);

// Column split (fraction of OCR pixel width): sidebar left, message area right.
const SIDEBAR_MAX_X_FRAC = 0.30;
const MSGAREA_MIN_X_FRAC = 0.33;

const SIDEBAR_ROW_LOGICAL_H = 71; // px, one chat row height (measured live)
const NAME_MIN_CONF = 0.82;

// Sidebar column geometry (fraction of OCR width), measured live 2026-07-10:
// avatar ≈ <0.095, chat name starts ≈0.105, timestamp column ≈0.23.
const NAME_X_MIN_FRAC = 0.09; // name starts right of the avatar
const NAME_X_MAX_FRAC = 0.20; // name ends left of the timestamp column
const TS_X_MIN_FRAC = 0.20; // timestamps sit in the right part of the sidebar
// A sidebar row's timestamp: 昨天/今天/星期X/上午|下午 HH:MM/HH:MM/M月D日/M/D.
const SIDEBAR_TS_RE = /(昨天|今天|星期|週[一二三四五六日]|上午|下午|AM|PM|\d{1,2}:\d{2}|\d{1,2}\s*月\s*\d{1,2}|\d{1,2}\/\d{1,2})/;

const TIME_RE = /(上午|下午|AM|PM|am|pm)?\s*\d{1,2}:\d{2}/;

// ---------------------------------------------------------------------------
// low-level process helpers
// ---------------------------------------------------------------------------

function resolveCliclick() {
  const cands = [
    process.env.CLICLICK_PATH,
    '/opt/homebrew/bin/cliclick',
    '/usr/local/bin/cliclick',
  ].filter(Boolean);
  for (const c of cands) if (existsSync(c)) return c;
  return 'cliclick'; // fall back to PATH resolution
}
const CLICLICK = resolveCliclick();

async function cliclick(args) {
  return execFileP(CLICLICK, args, {
    timeout: 8000,
    env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` },
  });
}

/** Snapshot the current mouse position as "x,y" (or null on failure). */
export async function saveCursor() {
  try {
    const { stdout } = await cliclick(['p']);
    const t = stdout.trim();
    return /^-?\d+,-?\d+$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

/** Move the mouse back to a saved "x,y" position (best effort). */
export async function restoreCursor(pos) {
  if (!pos) return;
  try {
    await cliclick([`m:${pos}`]);
  } catch {
    /* best effort */
  }
}

// Warn at most once per run: a large gap between where we AIMED a warp/click and
// where the cursor ACTUALLY landed means the event was dropped — almost always
// the launchd daemon missing the Accessibility TCC grant (posting HID events
// needs it; Screen Recording is a separate grant, and READING the cursor needs
// neither). Without this, an ineffective warp degrades silently to a
// first-screen-only scan. Threshold is generous (>40px) so it never fires on
// sub-pixel rounding or a normal in-window warp.
let _warpIneffectiveWarned = false;
function noteCursorDeviation(deviationPx) {
  if (deviationPx == null || deviationPx <= 40 || _warpIneffectiveWarned) return;
  _warpIneffectiveWarned = true;
  process.stderr.write(
    `警告：游標實際落點與預期相距 ${deviationPx}px——warp/scroll/click 可能未生效` +
      `（背景服務可能缺 Accessibility 權限，與螢幕錄製為不同授權；讀取游標不需此權限故不會報錯）。` +
      `掃描恐只讀到第一屏。\n`
  );
}

/** Name of the frontmost application (or null). */
export async function getFrontApp() {
  try {
    return await osa(
      'tell application "System Events" to return name of first application process whose frontmost is true',
      { timeoutMs: 5000 }
    );
  } catch {
    return null;
  }
}

async function activateApp(name) {
  if (!name) return;
  try {
    await osa(`tell application "${String(name).replace(/"/g, '\\"')}" to activate`, { timeoutMs: 8000 });
  } catch {
    /* best effort */
  }
}

/** Current HID idle time in seconds (time since last keyboard/mouse input). */
export async function idleSeconds() {
  const cmd = "ioreg -c IOHIDSystem | awk '/HIDIdleTime/{print $NF/1000000000; exit}'";
  const { stdout } = await execFileP('/bin/sh', ['-c', cmd], { timeout: 5000 });
  const v = parseFloat(stdout.trim());
  return Number.isFinite(v) ? v : 0;
}

// ---------------------------------------------------------------------------
// window / capture / ocr
// ---------------------------------------------------------------------------

async function readWinid() {
  const { stdout } = await execFileP(WINID_BIN, [], { timeout: 5000 });
  const t = stdout.trim();
  if (!t || t === 'NONE') return null;
  const parts = t.split(/\s+/).map(Number);
  if (parts.length < 5 || parts.some((n) => !Number.isFinite(n))) return null;
  const [wid, winX, winY, winW, winH] = parts;
  return { wid, winX, winY, winW, winH };
}

/**
 * Bring LINE to the foreground and wait until its main window is actually
 * rendered (winid returns a valid id). Solves the window-render race: activating
 * LINE does not mean the window exists yet.
 * @returns {Promise<{wid,winX,winY,winW,winH}>}
 */
export async function ensureLineForeground({ timeoutMs = 6000, intervalMs = 300 } = {}) {
  await activateApp('LINE');
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await getScanControl().checkpoint(); // honor abort/watchdog/activity even while waiting for the window
    const w = await readWinid();
    if (w) return w;
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
    // keep nudging LINE forward in case another app stole focus
    await activateApp('LINE');
  }
  throw new Error(
    'LINE 視窗未就緒：activate 後 6 秒內 winid 仍取不到有效主視窗。請確認 LINE 已登入、主視窗可開啟（非最小化）。'
  );
}

/** Screenshot a specific window id to a temp PNG. Caller should unlink it. */
export async function captureWindow(wid) {
  const png = join(tmpdir(), `linescan-${wid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  await execFileP('screencapture', ['-x', '-o', '-l', String(wid), png], { timeout: 10000 });
  if (!existsSync(png)) throw new Error(`screencapture 失敗：未產生 ${png}（螢幕錄製權限是否已授予？）`);
  return png;
}

/** OCR a PNG via native/ocr. @returns {{width,height,lines:Array}} */
export async function ocr(pngPath) {
  const { stdout } = await execFileP(OCR_BIN, [pngPath], { timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
  const j = JSON.parse(stdout);
  if (!j || !j.ok) throw new Error(`OCR 失敗：${stdout.slice(0, 200)}`);
  return j;
}

/** Capture + OCR the current LINE window in one step. */
async function captureOcr(wi) {
  await getScanControl().checkpoint(); // abort/watchdog/activity gate before every screenshot
  const png = await captureWindow(wi.wid);
  try {
    return await ocr(png);
  } finally {
    unlink(png).catch(() => {});
  }
}

/** ocr pixel bbox center -> on-screen logical coords for the given window. */
function pxToScreen(line, wi, scale) {
  const cx = line.x + line.w / 2;
  const cy = line.y + line.h / 2;
  return {
    screenX: Math.round(wi.winX + cx / scale),
    screenY: Math.round(wi.winY + cy / scale),
  };
}

// ---------------------------------------------------------------------------
// sidebar (chat list) reading
// ---------------------------------------------------------------------------

function isChatNameCandidate(text) {
  const t = (text || '').trim();
  if (!t) return false;
  if (SIDEBAR_UI_WORDS.has(t)) return false;
  if (/^\d{1,2}:\d{2}$/.test(t)) return false; // bare timestamp
  if (/^\d+$/.test(t)) return false; // unread badge count
  if (TIME_RE.test(t) && t.length <= 8) return false;
  return true;
}

/**
 * OCR the sidebar and return the currently-visible chatrooms with the *live*
 * screen coordinates of each row's name. Coordinates are only valid for the
 * current scroll position — re-OCR before every click (see locateChat).
 *
 * Heuristic (documented): keep only OCR lines in the left column
 * (x < 30% width); cluster them into rows by vertical gaps (~0.55 row height);
 * within each row the topmost line that looks like a name (conf > 0.82, not UI
 * chrome, not a bare timestamp/badge) is the chatroom name.
 *
 * Each row also carries the raw `marker` (its sidebar timestamp text, e.g.
 * "昨天"/"下午 3:24"/"6月30日") so the incremental filter can skip untouched
 * rooms — this reuses the OCR pass already done here (no extra screenshot).
 *
 * @returns {Promise<Array<{name,marker,screenX,screenY,pxY}>>}
 */
export async function listSidebarChats(wi) {
  const o = await captureOcr(wi);
  const scale = o.width / wi.winW;
  const rowHpx = SIDEBAR_ROW_LOGICAL_H * scale;
  const lines = o.lines || [];

  // Each chat row has a name (left column) and a timestamp (right column) on the
  // *same* baseline; message previews sit below the name and have NO adjacent
  // timestamp. So we pair every timestamp with the nearest-y name candidate —
  // this cleanly rejects previews/badges that the old topmost-line rule caught.
  const stamps = lines.filter(
    (l) => l.x > o.width * TS_X_MIN_FRAC && l.x < o.width * SIDEBAR_MAX_X_FRAC &&
      l.text.trim().length <= 10 && SIDEBAR_TS_RE.test(l.text)
  );
  const nameCands = lines.filter(
    (l) => l.x >= o.width * NAME_X_MIN_FRAC && l.x < o.width * NAME_X_MAX_FRAC &&
      isChatNameCandidate(l.text)
  );

  const chats = [];
  const usedName = new Set();
  const usedRowY = [];
  for (const ts of stamps.sort((a, b) => a.y - b.y)) {
    // nearest unused name on the same row baseline
    let best = null, bestDy = rowHpx * 0.5;
    for (const n of nameCands) {
      if (usedName.has(n)) continue;
      const dy = Math.abs(n.y - ts.y);
      if (dy < bestDy) { best = n; bestDy = dy; }
    }
    if (!best) continue;
    if (usedRowY.some((y) => Math.abs(y - best.y) < rowHpx * 0.4)) continue; // one name per row
    usedName.add(best);
    usedRowY.push(best.y);
    const { screenX, screenY } = pxToScreen(best, wi, scale);
    chats.push({ name: best.text.trim(), marker: ts.text.trim(), screenX, screenY, pxY: best.y });
  }
  chats.sort((a, b) => a.pxY - b.pxY);
  return chats;
}

function scrollScreenPoint(wi, col) {
  const fracX = col === 'sidebar' ? 0.15 : 0.65;
  return {
    x: Math.round(wi.winX + wi.winW * fracX),
    y: Math.round(wi.winY + wi.winH * 0.5),
  };
}

async function scrollSidebar(wi, lines) {
  // positive lines = up (toward top), negative = down (see native/scroll.swift)
  const ctl = getScanControl();
  await ctl.checkpoint(); // abort/watchdog/activity gate before every scroll
  ctl.tickScroll(); // per-stage scroll-iteration hard cap
  const p = scrollScreenPoint(wi, 'sidebar');
  await execFileP(SCROLL_BIN, [String(p.x), String(p.y), String(lines)], { timeout: 6000 });
  // scroll.swift warped the cursor toward (p.x,p.y). Record where it ACTUALLY
  // landed (read via cliclick, same source as the activity guard) — not the
  // intended point — so a warp that lands elsewhere (coord skew) or never fires
  // (daemon lacks Accessibility) can't be misread as the user moving the mouse.
  noteCursorDeviation(await ctl.recordActualCursor(p));
  await sleep(250);
}

async function scrollToSidebarTop(wi) {
  for (let i = 0; i < 8; i++) await scrollSidebar(wi, 8); // scroll up hard
}

/**
 * Normalize a chatroom name into a dedup key. OCR yields slightly different
 * strings for the same chat across overlapping scroll pages (trailing …/⋯/./•/以
 * bleed, half/full-width, whitespace). Strip trailing noise + member-count parens
 * so the same chat collapses to one key. Chinese OCR substitutions (盈↔圖) can
 * still split a chat; acceptable — Sung reconciles at blocklist time.
 */
export function normalizeChatName(name) {
  return (name || '')
    .replace(/[（(]\s*[^）)]*[）)]\s*$/u, '') // trailing (500)/(garbled) member count
    .replace(/[\s.．。・•·⋯…‥、,，:：以]+$/u, '') // trailing OCR bleed
    .replace(/[×✕Xx]/g, 'x') // unify Deepwave "×/X/x 夥伴" separators
    .replace(/[\s_]+/g, ' ')
    .toLowerCase()
    .trim();
}

/**
 * Enumerate the FULL chatroom name list by scrolling the sidebar top->bottom,
 * de-duplicating by normalized name (first-seen order preserved; longest raw
 * variant kept for display). Each room also carries its sidebar `marker`
 * timestamp text (first non-empty seen), reused by the incremental filter.
 * Coordinates are re-derived at click time.
 * @returns {Promise<Array<{name:string, key:string, marker:string|null}>>}
 */
export async function enumerateAllChats(wi, { maxPages = 40 } = {}) {
  const ctl = getScanControl();
  ctl.enterPhase('enumerate'); // starts the enumeration stage watchdog + scroll budget
  await scrollToSidebarTop(wi);
  const byKey = new Map();
  const markerByKey = new Map();
  const order = [];
  // Terminate on OCR-content stability: if two CONSECUTIVE pages show the exact
  // same set of visible names, we've reached the bottom. (Watchdog + scroll cap +
  // activity guard are the real safety net when the user is fighting the scroll —
  // this heuristic only handles the normal, undisturbed case.)
  let lastSig = null;
  let sameStreak = 0;
  for (let page = 0; page < maxPages; page++) {
    const visible = await listSidebarChats(wi);
    for (const c of visible) {
      const key = normalizeChatName(c.name);
      if (!key) continue;
      if (!byKey.has(key)) {
        byKey.set(key, c.name);
        markerByKey.set(key, c.marker || null);
        order.push(key);
      } else {
        if (c.name.length > byKey.get(key).length) byKey.set(key, c.name); // fullest OCR variant
        if (!markerByKey.get(key) && c.marker) markerByKey.set(key, c.marker); // backfill marker
      }
    }
    ctl.progress(`enumerate: page ${page + 1}, ${order.length} rooms so far`);
    const sig = visible.map((c) => c.name).sort().join('|');
    sameStreak = sig && sig === lastSig ? sameStreak + 1 : 0;
    lastSig = sig;
    if (sameStreak >= 1) break; // this page == previous page => two identical in a row => bottom
    await scrollSidebar(wi, -6); // scroll down one page
  }
  ctl.progress(`enumerate done: ${order.length} rooms in ${Math.round(ctl.elapsedMs() / 1000)}s`);
  return order.map((key) => ({ key, name: byKey.get(key), marker: markerByKey.get(key) || null }));
}

/**
 * Re-locate a chatroom by name and return fresh screen coordinates for its row.
 * Scrolls the sidebar from the top looking for the name. Throws with the seen
 * list if not found.
 */
async function locateChat(name, wi, { maxPages = 40 } = {}) {
  await scrollToSidebarTop(wi);
  const seen = new Set();
  let stalePages = 0;
  for (let page = 0; page < maxPages; page++) {
    const visible = await listSidebarChats(wi);
    const hit = visible.find((c) => c.name === name);
    if (hit) return hit;
    let added = 0;
    for (const c of visible) if (!seen.has(c.name)) { seen.add(c.name); added++; }
    stalePages = added === 0 ? stalePages + 1 : 0;
    if (stalePages >= 2) break;
    await scrollSidebar(wi, -6);
  }
  const list = [...seen].slice(0, 12).join(', ') || '（無法讀取任何列表項）';
  throw new Error(`聊天室「${name}」不在側邊欄可見範圍。掃到的前 12 項：${list}`);
}

// ---------------------------------------------------------------------------
// message-area reading + parsing
// ---------------------------------------------------------------------------

/**
 * Group OCR message-area lines into message bubbles by vertical gaps, then
 * split each group into {sender,time,text}. Heuristics (documented, best-effort):
 *   - time: any short fragment matching a HH:MM (optional 上午/下午/AM/PM) token.
 *   - sender: in a multi-line group whose first line is short (<=20 chars) and
 *     not a timestamp, the first line is treated as the sender name (LINE draws
 *     the sender above the bubble in group chats). Own messages have no sender.
 *   - raw is always preserved so nothing is silently lost.
 * order: oldest -> newest (top -> bottom), matching OCR sort order.
 */
const isTimeLine = (t) => TIME_RE.test(t) && t.trim().length <= 12;
// System separators LINE renders inside the message stream (not real messages).
const SYSTEM_LINES = [/^以下為尚未閱讀的訊息$/, /^尚未讀取的訊息$/, /^\d{4}[/年]\d{1,2}[/月]\d{1,2}/];

/**
 * Parse message-area OCR into {sender,time,text,raw}. Spatial model measured from
 * live LINE group chats:
 *   - fragments on the same baseline (Δy ≤ 0.6·avgH) are one logical line;
 *   - the sender name sits at the far-left margin, short & narrow, above its bubble;
 *   - a message's text lines share that left margin (others) or sit right-of-center
 *     (x > 50% width = my own messages, no sender);
 *   - a timestamp (右側 HH:MM) closes the current bubble.
 * Consecutive same-sender bubbles inherit the last seen sender (LINE only draws it
 * once); own (right-aligned) bubbles reset sender to null. raw always preserved.
 * order: oldest -> newest.
 * @param {Array} msgLines OCR lines already filtered to the message column
 * @param {number} ocrWidth OCR image width (for x-fraction thresholds)
 */
export function parseMessagesFromOcr(msgLines, ocrWidth = 0) {
  if (!msgLines.length) return [];

  // 1) merge same-baseline fragments into one logical line
  const sorted = [...msgLines].sort((a, b) => a.y - b.y || a.x - b.x);
  const avgH = sorted.reduce((s, l) => s + (l.h || 0), 0) / sorted.length || 20;
  const rows = [];
  for (const l of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(l.y - last.y) <= avgH * 0.6) last.parts.push(l);
    else rows.push({ y: l.y, parts: [l] });
  }
  const merged = rows
    .map((r) => {
      const parts = r.parts.sort((a, b) => a.x - b.x);
      return {
        x: Math.min(...parts.map((p) => p.x)),
        y: r.y,
        w: parts.reduce((s, p) => s + (p.w || 0), 0),
        text: parts.map((p) => p.text.trim()).filter(Boolean).join(' '),
      };
    })
    .filter((m) => {
      const t = m.text.trim();
      if (!t) return false;
      if (/^[<>«»‹›^v\\/|~•·．。、，,:：;；\-—_=+*#()（）\[\]{}]+$/u.test(t)) return false; // symbol junk
      return !SYSTEM_LINES.some((re) => re.test(t));
    });
  if (!merged.length) return [];

  // 2) geometry: left margin (sender/other column) and own-message threshold
  const W = ocrWidth || Math.max(...merged.map((m) => m.x + m.w), 1);
  const nonTime = merged.filter((m) => !isTimeLine(m.text));
  const leftMargin = nonTime.length ? Math.min(...nonTime.map((m) => m.x)) : 0;
  const senderMaxX = leftMargin + W * 0.06;
  const ownMinX = W * 0.5;

  // 3) walk into bubbles
  const out = [];
  let curr = null;
  let lastSender = null;
  const flush = () => {
    if (curr && (curr.textLines.length || curr.time)) {
      out.push({ sender: curr.sender, time: curr.time, text: curr.textLines.join('\n'), raw: curr.raw });
    }
    curr = null;
  };
  for (const m of merged) {
    const t = m.text.trim();
    if (isTimeLine(t)) {
      if (!curr) curr = { sender: lastSender, time: null, textLines: [], raw: [] };
      curr.time = (t.match(TIME_RE) || [t])[0].trim();
      curr.raw.push(t);
      flush();
      continue;
    }
    const isSender = m.x <= senderMaxX && t.length <= 20 && m.w < W * 0.22;
    if (isSender) {
      flush();
      lastSender = t;
      curr = { sender: t, time: null, textLines: [], raw: [t] };
      continue;
    }
    const isOwn = m.x > ownMinX;
    if (!curr) curr = { sender: isOwn ? null : lastSender, time: null, textLines: [], raw: [] };
    if (isOwn) curr.sender = null;
    curr.textLines.push(t);
    curr.raw.push(t);
  }
  flush();
  // keep only bubbles with actual text; a pure-timestamp bubble (image/sticker,
  // no OCR text) carries nothing for a text digest.
  return out.filter((m) => m.text && m.text.trim());
}

/** Scroll the message area up one screenful to reveal older messages. */
async function scrollMsgAreaUp(wi) {
  const ctl = getScanControl();
  await ctl.checkpoint();
  ctl.tickScroll();
  const p = scrollScreenPoint(wi, 'msg');
  await execFileP(SCROLL_BIN, [String(p.x), String(p.y), '5'], { timeout: 6000 });
  // Baseline on the cursor's ACTUAL landing (same-source read), not the aimed point.
  noteCursorDeviation(await ctl.recordActualCursor(p));
  await sleep(600);
}

/**
 * Open a chatroom (by name or {name}) and OCR its messages.
 *   - re-locates the row (fresh coords), clicks its center with cliclick,
 *   - waits ~1s for the chat to render, screenshots + OCRs,
 *   - keeps only the message-area column (x > 33% width),
 *   - optionally scrolls up `scrollRounds` extra screenfuls to load older
 *     history, merging + de-duplicating by text (heuristic; oldest first).
 * @returns {Promise<Array<{sender,time,text,raw}>>}
 */
export async function readChatMessages(chat, wi, { scrollRounds = 0 } = {}) {
  const name = typeof chat === 'string' ? chat : chat.name;
  const ctl = getScanControl();
  ctl.enterPhase(`chat:${name}`); // per-chat watchdog (locate + read) + fresh scroll budget
  const loc = await locateChat(name, wi);
  await ctl.checkpoint(); // gate before the click that opens the room
  await cliclick([`c:${loc.screenX},${loc.screenY}`]);
  await sleep(1000); // let the room render AND the cursor settle before we baseline it
  // Baseline on the cursor's ACTUAL settled position (same-source read), not the
  // intended click point — LINE's post-click layout can nudge the cursor a few
  // dozen px, which must not be read as the user grabbing the mouse.
  noteCursorDeviation(await ctl.recordActualCursor({ x: loc.screenX, y: loc.screenY }));

  const passes = [];
  for (let round = 0; round <= scrollRounds; round++) {
    if (round > 0) await scrollMsgAreaUp(wi);
    const o = await captureOcr(wi);
    const minX = o.width * MSGAREA_MIN_X_FRAC;
    // drop the top header bar (chat title / search box / back button) and the
    // bottom input box; real messages begin well below ~11% (measured live).
    const topCut = o.height * 0.11;
    const botCut = o.height * 0.92;
    const msgLines = (o.lines || []).filter((l) => l.x > minX && l.y > topCut && l.y < botCut);
    passes.push(parseMessagesFromOcr(msgLines, o.width));
  }

  // passes[0] = current (newest) screen; later passes are older (scrolled up).
  // Merge oldest-first, de-duplicating by a normalized text fingerprint.
  const seen = new Set();
  const merged = [];
  for (let i = passes.length - 1; i >= 0; i--) {
    for (const m of passes[i]) {
      const fp = fingerprint(m);
      if (seen.has(fp)) continue;
      seen.add(fp);
      merged.push(m);
    }
  }
  return merged;
}

/** Stable fingerprint of a parsed message (sender+time+normalized text). */
export function fingerprint(m) {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  return `${norm(m.sender)}${norm(m.time)}${norm(m.text)}`;
}

// ---------------------------------------------------------------------------
// focus envelope
// ---------------------------------------------------------------------------

/**
 * Run `fn` with the cursor + frontmost app snapshotted on entry and restored on
 * exit (including on error). This is the "don't leave a trace" guarantee: if the
 * user walks back to the keyboard mid-scan, their previous app + cursor return.
 */
export async function withFocusRestore(fn) {
  const prevApp = await getFrontApp();
  const prevCursor = await saveCursor();
  // Seed the activity guard with the user's cursor at entry: checkpoint #1 already
  // compares live cursor vs this baseline, so a scan that starts while the user is
  // moving the mouse trips the guard immediately instead of after the first scroll.
  if (!prevCursor) {
    process.stderr.write(
      '警告：讀不到游標位置（cliclick p 失敗）——本次執行的「使用者活動偵測」失效，僅剩 watchdog/哨兵保護。\n'
    );
  }
  getScanControl().recordCursor(prevCursor);
  try {
    return await fn();
  } finally {
    await restoreCursor(prevCursor);
    if (prevApp && prevApp !== 'LINE') await activateApp(prevApp);
  }
}
