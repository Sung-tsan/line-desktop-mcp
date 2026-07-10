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

/** Filter enumerated chats by the blocklist. Returns the kept chats. */
export function applyBlocklist(chats, blocklist) {
  const excl = new Set(blocklist.excludeNames || []);
  return chats.filter((c) => !excl.has(c.name));
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

export { STATE_DIR, OUT_DIR };
