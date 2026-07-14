// state.js — persistent scan state (blocklist / seen-chats / last-scan / outputs).
//
// All paths derive from import.meta.url, NOT os.homedir, so a launchd-driven run
// (different cwd/HOME) reads and writes the same files as an interactive run.
//
// Files that contain real chatroom / contact names are gitignored; only the
// *.example.json templates are committed.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, 'state');
const OUT_DIR = join(STATE_DIR, 'out');

const BLOCKLIST = join(STATE_DIR, 'blocklist.json');
const SEEN_CHATS = join(STATE_DIR, 'seen-chats.json');
const LAST_SCAN = join(STATE_DIR, 'last-scan.json');
const SCAN_META = join(STATE_DIR, 'scan-meta.json');

// Incremental safety margin: a room is only skipped when its sidebar marker
// resolves to a time older than (lastSuccessAt - this). Absorbs OCR/parse slop
// and clock jitter so we never skip a room that got a message near the boundary.
const INCREMENTAL_MARGIN_MS = 30 * 60 * 1000;

const DEFAULT_BLOCKLIST = { excludeNames: [], excludeOfficialAccountsTab: true };
const FP_CAP = 200; // keep at most this many recent fingerprints per chat

async function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return structuredClone(fallback);
    const txt = await readFile(path, 'utf8');
    return JSON.parse(txt);
  } catch {
    return structuredClone(fallback);
  }
}

async function writeJson(path, obj) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

export async function ensureDirs() {
  await mkdir(OUT_DIR, { recursive: true });
}

export async function loadBlocklist() {
  const b = await readJson(BLOCKLIST, DEFAULT_BLOCKLIST);
  return {
    excludeNames: Array.isArray(b.excludeNames) ? b.excludeNames : [],
    excludeOfficialAccountsTab: b.excludeOfficialAccountsTab !== false,
  };
}

// Light normalizer for blocklist matching (mirrors scan-engine.normalizeChatName;
// duplicated here to avoid a circular import). Lowercases, strips member-count
// parens / trailing OCR bleed, unifies ×/x separators & spaces.
function normForMatch(name) {
  return (name || '')
    .replace(/[（(]\s*[^）)]*[）)]\s*$/u, '')
    .replace(/[\s.．。・•·⋯…‥、,，:：以]+$/u, '')
    .replace(/[×✕Xx]/g, 'x')
    .replace(/[\s_]+/g, ' ')
    .toLowerCase()
    .trim();
}

/**
 * Filter enumerated chats by the blocklist. An excludeNames entry is treated as a
 * substring pattern: a chat is dropped if any (normalized) exclude entry is
 * contained in the (normalized) chat name. This tolerates OCR variance, member
 * counts, and lets short keywords (e.g. "華南銀行") match longer chat titles.
 * Returns the kept chats.
 */
export function applyBlocklist(chats, blocklist) {
  const patterns = (blocklist.excludeNames || [])
    .map(normForMatch)
    .filter(Boolean);
  return chats.filter((c) => {
    const n = normForMatch(c.name);
    return !patterns.some((p) => n.includes(p));
  });
}

/**
 * Compare the current chat name list against seen-chats.json.
 * Returns the set of names appearing for the first time, and persists the union.
 * (New chatrooms are scanned by default — Sung meets new people daily — and only
 * surfaced in the report so he can choose to add them to the blocklist.)
 */
export async function updateSeenChats(names) {
  const state = await readJson(SEEN_CHATS, { names: [], updatedAt: null });
  const known = new Set(state.names || []);
  const firstSeen = names.filter((n) => !known.has(n));
  for (const n of names) known.add(n);
  await writeJson(SEEN_CHATS, { names: [...known].sort(), updatedAt: new Date().toISOString() });
  return new Set(firstSeen);
}

/**
 * Given a chat name and its freshly-read messages (each a parsed object with a
 * `fingerprint`-able shape), return only the messages not seen in a prior scan,
 * and persist the updated fingerprint window.
 * @param {string} name
 * @param {Array<{fp:string}>} messagesWithFp
 */
export async function diffAndRecord(name, messagesWithFp) {
  const state = await readJson(LAST_SCAN, {});
  const prev = new Set((state[name] && state[name].fps) || []);
  const fresh = messagesWithFp.filter((m) => !prev.has(m.fp));

  // roll the fingerprint window forward (bounded)
  const union = [...prev, ...fresh.map((m) => m.fp)];
  const capped = union.slice(Math.max(0, union.length - FP_CAP));
  state[name] = { fps: capped, updatedAt: new Date().toISOString() };
  await writeJson(LAST_SCAN, state);
  return fresh;
}

// ---------------------------------------------------------------------------
// incremental-scan watermark (scan-meta.json)
// ---------------------------------------------------------------------------

/**
 * Read the incremental-scan watermark. `lastSuccessAt` is the ISO start time of
 * the most recent scan that fully completed AND landed its results (see
 * writeScanMeta callers). null when never scanned -> caller does a full scan.
 * @returns {Promise<{lastSuccessAt: string|null}>}
 */
export async function readScanMeta() {
  const m = await readJson(SCAN_META, { lastSuccessAt: null });
  return { lastSuccessAt: m && m.lastSuccessAt ? m.lastSuccessAt : null };
}

/** Persist the watermark. Pass the scan's START time (not end) so messages that
 *  arrived mid-scan are re-read next time (rather-re-scan-than-miss). */
export async function writeScanMeta(meta) {
  await writeJson(SCAN_META, {
    lastSuccessAt: (meta && meta.lastSuccessAt) || null,
    updatedAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// sidebar-marker resolution (pure) — used to decide which rooms to skip
// ---------------------------------------------------------------------------

const WEEKDAY_MAP = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

function ymdUpperBound(month, day, now) {
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  // End of that calendar day in THIS year; if that is still in the future the
  // sidebar must mean last year (LINE shows M月D日 only for past messages).
  let d = new Date(now.getFullYear(), month - 1, day, 23, 59, 0, 0);
  if (d.getTime() > now.getTime()) d = new Date(now.getFullYear() - 1, month - 1, day, 23, 59, 0, 0);
  return d;
}

/**
 * Resolve a LINE sidebar timestamp marker into the LATEST possible time that
 * room's newest message could have — an UPPER bound (23:59 for day-granular
 * markers) so we bias toward re-scanning, never toward skipping. Pure & tz-local.
 *
 *   'HH:MM' / '上午|下午 H:MM'  -> today at that time (下午+12; 上午12->0; 下午12->12)
 *   '昨天'                      -> yesterday 23:59
 *   '星期X' / '週X'             -> the most recent PAST occurrence of that weekday, 23:59
 *   'M月D日' / 'M/D'            -> that date this year 23:59 (last year if future)
 *   '今天' (bare)               -> today 23:59
 *   anything else               -> null (unparseable -> caller must scan)
 *
 * @param {string} markerText raw sidebar timestamp text
 * @param {Date} [now] injected clock (defaults to new Date())
 * @returns {Date|null}
 */
export function resolveSidebarMarker(markerText, now = new Date()) {
  const t = String(markerText || '').trim();
  if (!t) return null;

  if (t.includes('昨天')) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    d.setHours(23, 59, 0, 0);
    return d;
  }

  const wd = t.match(/(?:星期|週|周)\s*([一二三四五六日天])/);
  if (wd) {
    const target = WEEKDAY_MAP[wd[1]];
    if (target === undefined) return null;
    let daysAgo = (now.getDay() - target + 7) % 7;
    if (daysAgo === 0) daysAgo = 7; // same weekday label = a week ago, never today
    const d = new Date(now);
    d.setDate(d.getDate() - daysAgo);
    d.setHours(23, 59, 0, 0);
    return d;
  }

  const cdate = t.match(/(\d{1,2})\s*月\s*(\d{1,2})/);
  if (cdate) return ymdUpperBound(Number(cdate[1]), Number(cdate[2]), now);

  const ndate = t.match(/^(\d{1,2})\/(\d{1,2})$/); // slash => date, not HH:MM
  if (ndate) return ymdUpperBound(Number(ndate[1]), Number(ndate[2]), now);

  const tm = t.match(/(上午|下午|AM|PM|am|pm)?\s*(\d{1,2}):(\d{2})/);
  if (tm) {
    let h = Number(tm[2]);
    const min = Number(tm[3]);
    if (h > 23 || min > 59) return null;
    const merid = tm[1];
    const isPm = merid === '下午' || merid === 'PM' || merid === 'pm';
    const isAm = merid === '上午' || merid === 'AM' || merid === 'am';
    if (isPm && h < 12) h += 12; // 下午 3 -> 15 ; 下午 12 stays 12 (noon)
    if (isAm && h === 12) h = 0; // 上午 12 -> 0 (midnight)
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    return d;
  }

  if (t.includes('今天')) {
    const d = new Date(now);
    d.setHours(23, 59, 0, 0);
    return d;
  }

  return null;
}

/**
 * Decide whether a room can be SKIPPED this scan (incremental mode). Skip only
 * when there is a prior watermark AND the room's marker resolves to a time
 * strictly older than (lastSuccessAt - safety margin). Unparseable markers and
 * anything newer are scanned (fail-open: an OCR misread must never lose messages).
 * @param {string} markerText
 * @param {string|null} lastSuccessAt ISO string, or null (=> never skip)
 * @param {Date} [now]
 */
export function shouldSkipRoom(markerText, lastSuccessAt, now = new Date()) {
  if (!lastSuccessAt) return false; // no baseline -> full scan
  const marker = resolveSidebarMarker(markerText, now);
  if (!marker) return false; // unparseable -> fail-open (scan)
  const cutoff = new Date(lastSuccessAt).getTime() - INCREMENTAL_MARGIN_MS;
  if (!Number.isFinite(cutoff)) return false; // bad watermark -> fail-open
  return marker.getTime() < cutoff;
}

export { STATE_DIR, OUT_DIR, INCREMENTAL_MARGIN_MS };
