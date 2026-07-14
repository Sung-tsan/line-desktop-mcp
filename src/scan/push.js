// push.js — push a finished scan to the DIKW ingest API, with an offline outbox.
//
// Config source (first match wins per field):
//   1. env DIKW_INGEST_URL / DIKW_INGEST_TOKEN
//   2. src/scan/state/dikw.json  { "url": "...", "token": "..." }
// Neither present -> pushing is skipped (not an error; logged once per call).
//
// Outbox: scan JSONs that failed to push for a retryable reason (network down,
// timeout, 5xx, unexpected status) are enqueued by *filename reference* into
// src/scan/state/outbox.json (the scan JSON itself already lives in state/out/,
// no need to duplicate its content). Each entry is retried on every subsequent
// scan-once run via flushOutbox(), before the new scan is pushed, so nothing
// gets pushed out of order. A 401 (bad token) or 400 (bad payload shape) is
// NOT retryable -- resending the same bytes will never succeed -- so those are
// never enqueued, and if encountered again on retry the entry is marked dead
// immediately. Entries hitting 10 retryable failures are also marked dead:
// they stay in outbox.json (for manual inspection) but are skipped on future
// flushes until someone deletes them or fixes the underlying problem.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { STATE_DIR, OUT_DIR } from './state.js';

const DIKW_CONFIG_PATH = join(STATE_DIR, 'dikw.json');
const OUTBOX_PATH = join(STATE_DIR, 'outbox.json');
// 60s：server 端首次大量回填(逐則寫 Notion)可能跑很久;誤判逾時會讓 outbox 空轉。
// server 端有去重,重送無害,但 timeout 仍應蓋過正常處理時間。可由 config 覆蓋。
const DEFAULT_PUSH_TIMEOUT_MS = 60000;
const MAX_ATTEMPTS = 10;

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

/**
 * Resolve DIKW ingest config from env (wins) then state/dikw.json.
 * Returns { url, token } or null if either field is missing (pushing skipped).
 */
export async function loadDikwConfig() {
  const file = await readJson(DIKW_CONFIG_PATH, {});
  const url = process.env.DIKW_INGEST_URL || file.url || '';
  const token = process.env.DIKW_INGEST_TOKEN || file.token || '';
  if (!url || !token) {
    const missing = [!url && 'url', !token && 'token'].filter(Boolean).join('/');
    console.error(
      `DIKW 推送：未設定 ${missing}（env DIKW_INGEST_URL/DIKW_INGEST_TOKEN 或 src/scan/state/dikw.json 皆無），跳過推送。`
    );
    return null;
  }
  const timeoutMs =
    Number(process.env.DIKW_INGEST_TIMEOUT_MS) || Number(file.timeoutMs) || DEFAULT_PUSH_TIMEOUT_MS;
  return { url: url.replace(/\/+$/, ''), token, timeoutMs };
}

/**
 * POST a scan object to `${url}/api/ingest/line`.
 * Returns one of:
 *   { status: 'ok', body }
 *   { status: 'auth', httpStatus: 401, message }      -- do not retry
 *   { status: 'bad_request', httpStatus: 400, message } -- do not retry
 *   { status: 'error', message }                        -- retryable (network/timeout/5xx/other)
 */
export async function pushScan(scan, config) {
  const timeoutMs = config.timeoutMs || DEFAULT_PUSH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.url}/api/ingest/line`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(scan),
      signal: controller.signal,
    });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (res.status === 200) {
      return { status: 'ok', body };
    }
    if (res.status === 401) {
      return { status: 'auth', httpStatus: 401, message: body?.error || body?.raw || 'unauthorized' };
    }
    if (res.status === 400) {
      return { status: 'bad_request', httpStatus: 400, message: body?.error || body?.raw || 'bad request' };
    }
    return { status: 'error', message: `HTTP ${res.status}: ${body?.error || body?.raw || text || '(no body)'}` };
  } catch (e) {
    const msg = e?.name === 'AbortError' ? `逾時（>${timeoutMs}ms）` : e?.message || String(e);
    return { status: 'error', message: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire-and-forget scan status update to `${url}/api/line-scan` so the DIKW web
 * panel can show "did it start / where is it / did it finish". NEVER throws and
 * never blocks the scan (10s timeout, all errors swallowed) — status reporting
 * must not be able to break scanning. Silently no-ops when push isn't configured.
 * States (see dikw-loop /api/line-scan): waiting|running|done|aborted|gaveup.
 * Optional `counts` ({received,written,deduped}) is attached to the body when
 * given so the panel can show "did it actually capture anything" (else omitted,
 * keeping the old body shape for callers that don't pass it).
 */
export async function postStatus(state, stage = '', detail = '', counts = null) {
  try {
    const config = await loadDikwConfig();
    if (!config) return;
    const body = { op: 'status', state, stage, detail };
    if (counts) body.counts = counts;
    await fetch(`${config.url}/api/line-scan`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    /* status 回報失敗不影響掃描本體 */
  }
}

async function readOutbox() {
  const o = await readJson(OUTBOX_PATH, { entries: [] });
  return Array.isArray(o.entries) ? o.entries : [];
}

async function writeOutbox(entries) {
  await writeJson(OUTBOX_PATH, { entries });
}

/**
 * Enqueue a scan JSON (by filename under state/out/) into the outbox for
 * later retry. Idempotent: won't add a duplicate entry for the same file.
 */
export async function enqueueOutbox(jsonFilePath) {
  const file = jsonFilePath.includes('/') ? jsonFilePath.split('/').pop() : jsonFilePath;
  const entries = await readOutbox();
  if (entries.some((e) => e.file === file)) return;
  entries.push({
    file,
    attempts: 0,
    dead: false,
    queuedAt: new Date().toISOString(),
    lastAttemptAt: null,
    lastError: null,
  });
  await writeOutbox(entries);
  console.error(`DIKW 推送：已加入 outbox 待補推（${file}）。`);
}

/**
 * Retry every non-dead outbox entry against the current config.
 * Successful pushes are removed; retryable failures bump `attempts` (and get
 * marked dead at MAX_ATTEMPTS); a 401/400 on retry marks the entry dead
 * immediately since resending won't help.
 */
export async function flushOutbox(config) {
  const entries = await readOutbox();
  if (entries.length === 0) return;

  const deadOnEntry = entries.filter((e) => e.dead);
  if (deadOnEntry.length > 0) {
    console.error(
      `DIKW 推送：outbox 中有 ${deadOnEntry.length} 筆已標記 dead（重試上限或不可重試錯誤），需人工檢查 ${OUTBOX_PATH}。`
    );
  }

  const pending = entries.filter((e) => !e.dead);
  if (pending.length === 0) return;

  console.error(`DIKW 推送：outbox 有 ${pending.length} 筆待補推，開始重試...`);

  const kept = [...deadOnEntry];
  for (const entry of pending) {
    const scanPath = join(OUT_DIR, entry.file);
    if (!existsSync(scanPath)) {
      console.error(`DIKW 推送：outbox 條目對應的檔案不存在，移除（${entry.file}）。`);
      continue; // drop: nothing to retry
    }
    let scan;
    try {
      scan = JSON.parse(await readFile(scanPath, 'utf8'));
    } catch (e) {
      console.error(`DIKW 推送：outbox 條目檔案無法解析 JSON，移除（${entry.file}）：${e?.message || e}`);
      continue;
    }

    const result = await pushScan(scan, config);
    if (result.status === 'ok') {
      console.error(
        `DIKW 推送：補推成功（${entry.file}）received=${result.body?.received} written=${result.body?.written} deduped=${result.body?.deduped}`
      );
      continue; // drop from outbox
    }

    if (result.status === 'auth' || result.status === 'bad_request') {
      console.error(
        `DIKW 推送：補推失敗且不可重試（${entry.file}，HTTP ${result.httpStatus} ${result.message}），標記 dead，保留供人工檢查。`
      );
      kept.push({ ...entry, dead: true, lastAttemptAt: new Date().toISOString(), lastError: `${result.httpStatus} ${result.message}` });
      continue;
    }

    const attempts = entry.attempts + 1;
    const lastError = result.message;
    if (attempts >= MAX_ATTEMPTS) {
      console.error(
        `DIKW 推送：補推失敗（${entry.file}）已達重試上限 ${MAX_ATTEMPTS} 次，標記 dead，保留供人工檢查：${lastError}`
      );
      kept.push({ ...entry, attempts, dead: true, lastAttemptAt: new Date().toISOString(), lastError });
    } else {
      console.error(`DIKW 推送：補推失敗（${entry.file}，第 ${attempts} 次），下次掃描再試：${lastError}`);
      kept.push({ ...entry, attempts, lastAttemptAt: new Date().toISOString(), lastError });
    }
  }

  await writeOutbox(kept);
}

export { OUTBOX_PATH, DIKW_CONFIG_PATH };
