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
 * @returns {Promise<Array<{name,screenX,screenY,pxY}>>}
 */
export async function listSidebarChats(wi) {
  const o = await captureOcr(wi);
  const scale = o.width / wi.winW;
  const sidebarMaxX = o.width * SIDEBAR_MAX_X_FRAC;
  const rowHpx = SIDEBAR_ROW_LOGICAL_H * scale;

  const left = (o.lines || [])
    .filter((l) => l.x < sidebarMaxX)
    .sort((a, b) => a.y - b.y);

  const chats = [];
  let lastRowY = -Infinity;
  for (const l of left) {
    const startsNewRow = l.y - lastRowY > rowHpx * 0.55;
    if (!startsNewRow) continue; // only the topmost line of each row is the name
    lastRowY = l.y;
    if ((l.conf ?? 1) < NAME_MIN_CONF) continue;
    if (!isChatNameCandidate(l.text)) continue;
    const { screenX, screenY } = pxToScreen(l, wi, scale);
    chats.push({ name: l.text.trim(), screenX, screenY, pxY: l.y });
  }
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
  const p = scrollScreenPoint(wi, 'sidebar');
  await execFileP(SCROLL_BIN, [String(p.x), String(p.y), String(lines)], { timeout: 6000 });
  await sleep(250);
}

async function scrollToSidebarTop(wi) {
  for (let i = 0; i < 8; i++) await scrollSidebar(wi, 8); // scroll up hard
}

/**
 * Enumerate the FULL chatroom name list by scrolling the sidebar top->bottom,
 * de-duplicating by name (first-seen order preserved). Returns names only;
 * coordinates are re-derived at click time because they go stale on scroll.
 * @returns {Promise<Array<{name:string}>>}
 */
export async function enumerateAllChats(wi, { maxPages = 40 } = {}) {
  await scrollToSidebarTop(wi);
  const seen = new Set();
  const ordered = [];
  let stalePages = 0;
  for (let page = 0; page < maxPages; page++) {
    const visible = await listSidebarChats(wi);
    let added = 0;
    for (const c of visible) {
      if (!seen.has(c.name)) {
        seen.add(c.name);
        ordered.push({ name: c.name });
        added++;
      }
    }
    stalePages = added === 0 ? stalePages + 1 : 0;
    if (stalePages >= 2) break; // two full pages with nothing new = reached bottom
    await scrollSidebar(wi, -6); // scroll down one page
  }
  return ordered;
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
export function parseMessagesFromOcr(msgLines) {
  if (!msgLines.length) return [];
  const sorted = [...msgLines].sort((a, b) => a.y - b.y);
  const avgH = sorted.reduce((s, l) => s + (l.h || 0), 0) / sorted.length || 20;
  const gapThreshold = avgH * 1.8;

  const groups = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].y - sorted[i - 1].y > gapThreshold) {
      groups.push(cur);
      cur = [];
    }
    cur.push(sorted[i]);
  }
  if (cur.length) groups.push(cur);

  return groups.map((g) => {
    const raw = g.map((l) => l.text.trim()).filter(Boolean);
    let time = null;
    const rest = [];
    for (const t of raw) {
      if (!time && TIME_RE.test(t) && t.length <= 12) time = t.match(TIME_RE)[0].trim();
      else rest.push(t);
    }
    let sender = null;
    let text;
    if (rest.length >= 2 && rest[0].length <= 20) {
      sender = rest[0];
      text = rest.slice(1).join('\n');
    } else {
      text = rest.join('\n');
    }
    return { sender, time, text, raw };
  }).filter((m) => m.text || m.raw.length);
}

/** Scroll the message area up one screenful to reveal older messages. */
async function scrollMsgAreaUp(wi) {
  const p = scrollScreenPoint(wi, 'msg');
  await execFileP(SCROLL_BIN, [String(p.x), String(p.y), '5'], { timeout: 6000 });
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
  const loc = await locateChat(name, wi);
  await cliclick([`c:${loc.screenX},${loc.screenY}`]);
  await sleep(1000);

  const passes = [];
  for (let round = 0; round <= scrollRounds; round++) {
    if (round > 0) await scrollMsgAreaUp(wi);
    const o = await captureOcr(wi);
    const minX = o.width * MSGAREA_MIN_X_FRAC;
    const msgLines = (o.lines || []).filter((l) => l.x > minX);
    passes.push(parseMessagesFromOcr(msgLines));
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
  try {
    return await fn();
  } finally {
    await restoreCursor(prevCursor);
    if (prevApp && prevApp !== 'LINE') await activateApp(prevApp);
  }
}
