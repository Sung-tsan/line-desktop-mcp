// scan-control.js — safety spine for the LINE scanner.
//
// Why this file exists (2026-07-10 real incident): a `--force` scan launched
// while the user was actively working. The idle gate was only checked at
// startup, `--force` skipped it, and once running there was NO way to stop:
//   - no abort switch,
//   - no total/per-stage timeout,
//   - no mid-run "the user is back" detection,
//   - zero progress output (30+ minutes of silence).
// The cursor was hijacked for half an hour as the sidebar-enumeration scroll
// loop fought the user's own mouse (its "reached bottom" test never became
// true) until an external `pkill` killed it.
//
// This module gives every dangerous step (screenshot / cliclick / scroll) a
// single mandatory checkpoint that enforces, IN EVERY MODE (including --force
// and the daemon):
//   A. abort sentinel  — src/scan/state/ABORT exists -> stop at next checkpoint
//   B. layered watchdog — total, per-stage, and scroll-iteration hard caps
//   C. activity guard   — current cursor vs where the script last parked it
//                         (cliclick synthetic events reset HIDIdleTime, so idle
//                          time is useless mid-run; cursor position is not).
//
// It has NO dependency on scan-engine (engine imports this), so it is unit
// testable without touching the GUI.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

export const STATE_DIR = join(__dirname, 'state');
export const ABORT_FILE = join(STATE_DIR, 'ABORT');

// ---------------------------------------------------------------------------
// defaults (all overridable via env or initScanControl opts)
// ---------------------------------------------------------------------------
export const DEFAULTS = {
  totalMs: 10 * 60 * 1000, // whole sweep hard ceiling
  enumMs: 90 * 1000, // sidebar enumeration stage ceiling
  chatMs: 30 * 1000, // single chatroom read ceiling (incl. locate)
  scrollMax: 60, // scroll iterations per stage, hard cap
  cursorTolerancePx: 10, // movement beyond this = the user is back
  progressEvery: 5, // emit a progress line every N scrolls
};

function envNum(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

/** Resolve config from opts -> env -> DEFAULTS (opts win, then env). */
export function resolveConfig(opts = {}) {
  return {
    totalMs: opts.totalMs ?? envNum('SCAN_TOTAL_MS', DEFAULTS.totalMs),
    enumMs: opts.enumMs ?? envNum('SCAN_ENUM_MS', DEFAULTS.enumMs),
    chatMs: opts.chatMs ?? envNum('SCAN_CHAT_MS', DEFAULTS.chatMs),
    scrollMax: opts.scrollMax ?? envNum('SCAN_SCROLL_MAX', DEFAULTS.scrollMax),
    cursorTolerancePx:
      opts.cursorTolerancePx ?? envNum('SCAN_CURSOR_TOL_PX', DEFAULTS.cursorTolerancePx),
    progressEvery: opts.progressEvery ?? envNum('SCAN_PROGRESS_EVERY', DEFAULTS.progressEvery),
  };
}

// ---------------------------------------------------------------------------
// abort error — carries a scope so callers know how far to unwind
// ---------------------------------------------------------------------------
// scope 'scan' = fatal, abort the whole sweep, restore, write partial, exit != 0
// scope 'chat' = recoverable, skip the current chatroom, keep going
export class ScanAbort extends Error {
  constructor(reason, phase, scope = 'scan', evidence = null) {
    super(`scan aborted: ${reason} (stage=${phase}, scope=${scope})`);
    this.name = 'ScanAbort';
    this.reason = reason; // 'sentinel' | 'timeout' | 'scroll-cap' | 'activity'
    this.phase = phase;
    this.scope = scope;
    // For 'activity': the exact signal that tripped the guard
    // ({recorded, observed, distancePx, tolerancePx, source}), so a *false*
    // activity abort is diagnosable from the JSON instead of a bare
    // {reason:'activity'} — being un-diagnosable is exactly what cost us the
    // 2026-07-18..22 investigation.
    this.evidence = evidence;
  }
}
export const isFatalAbort = (e) => e instanceof ScanAbort && e.scope === 'scan';

// ---------------------------------------------------------------------------
// cursor primitives (pure + a thin cliclick wrapper) — unit-testable
// ---------------------------------------------------------------------------
function resolveCliclick() {
  const cands = [process.env.CLICLICK_PATH, '/opt/homebrew/bin/cliclick', '/usr/local/bin/cliclick'].filter(
    Boolean
  );
  for (const c of cands) if (existsSync(c)) return c;
  return 'cliclick';
}

/** Parse cliclick's "x,y" position string into {x,y}, or null if malformed. */
export function parseCursor(s) {
  const t = String(s || '').trim();
  if (!/^-?\d+,-?\d+$/.test(t)) return null;
  const [x, y] = t.split(',').map(Number);
  return { x, y };
}

/** Euclidean distance between two {x,y} (or Infinity if either missing). */
export function cursorDistance(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** True if `cur` moved farther than `tol` px from `expected`. */
export function cursorMovedBeyond(cur, expected, tol) {
  if (!expected) return false; // no baseline yet -> cannot judge, don't false-trip
  if (!cur) return false; // couldn't read -> don't false-trip on a read failure
  return cursorDistance(cur, expected) > tol;
}

/** Read the live mouse position as {x,y} (or null). Read-only: no cursor move. */
export async function readMousePosition() {
  try {
    const { stdout } = await execFileP(resolveCliclick(), ['p'], {
      timeout: 5000,
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` },
    });
    return parseCursor(stdout);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// sentinel helpers
// ---------------------------------------------------------------------------
export function abortSentinelExists() {
  return existsSync(ABORT_FILE);
}

/** Remove a stale sentinel left by a previous aborted run (called at startup). */
export function clearAbortSentinel() {
  try {
    if (existsSync(ABORT_FILE)) unlinkSync(ABORT_FILE);
  } catch {
    /* best effort */
  }
}

/** Create the sentinel (used by scan-abort.sh via `node -e`, and by tests). */
export function writeAbortSentinel(note = '') {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(ABORT_FILE, `${new Date().toISOString()} ${note}`.trim() + '\n', 'utf8');
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// the controller
// ---------------------------------------------------------------------------
class ScanController {
  constructor(cfg, readCursor) {
    this.cfg = cfg;
    this.readCursor = readCursor || readMousePosition;
    const now = Date.now();
    this.startedAt = now;
    this.totalDeadline = now + cfg.totalMs;
    this.phase = 'init';
    this.phaseDeadline = Infinity;
    this.scrollCount = 0; // reset per stage
    this.lastPlaced = null; // {x,y} where the script last parked the cursor
    this.enabled = true;
  }

  /** stage scope: enumerate/total timeouts are fatal; a single chat is skippable. */
  _scopeForPhase(phase) {
    return String(phase).startsWith('chat') ? 'chat' : 'scan';
  }

  /** Begin a timed stage with a fresh scroll budget. ms defaults per stage kind. */
  enterPhase(name, ms) {
    this.phase = name;
    const budget = Number.isFinite(ms)
      ? ms
      : String(name).startsWith('chat')
        ? this.cfg.chatMs
        : String(name).startsWith('enumerate')
          ? this.cfg.enumMs
          : this.cfg.totalMs;
    this.phaseDeadline = Date.now() + budget;
    this.scrollCount = 0;
  }

  /** Record where the script just parked the cursor (after click/scroll/warp). */
  recordCursor(pos) {
    if (typeof pos === 'string') this.lastPlaced = parseCursor(pos);
    else if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) this.lastPlaced = { x: pos.x, y: pos.y };
  }

  _checkSentinel() {
    if (abortSentinelExists()) throw new ScanAbort('sentinel', this.phase, 'scan');
  }

  _checkDeadlines() {
    const now = Date.now();
    if (now >= this.totalDeadline) throw new ScanAbort('timeout', 'total', 'scan');
    if (now >= this.phaseDeadline) throw new ScanAbort('timeout', this.phase, this._scopeForPhase(this.phase));
  }

  async _checkActivity() {
    if (!this.lastPlaced) return;
    const cur = await this.readCursor();
    if (cursorMovedBeyond(cur, this.lastPlaced, this.cfg.cursorTolerancePx)) {
      throw new ScanAbort('activity', this.phase, 'scan', {
        recorded: { x: this.lastPlaced.x, y: this.lastPlaced.y }, // where WE parked/observed the cursor last
        observed: cur ? { x: cur.x, y: cur.y } : null, // live cursor now (same source as `recorded`)
        distancePx: Math.round(cursorDistance(cur, this.lastPlaced)),
        tolerancePx: this.cfg.cursorTolerancePx,
        source: 'cliclick', // both endpoints read via cliclick p, so this is a real move, not a coord-space mismatch
      });
    }
  }

  /**
   * Park the activity baseline on the cursor's ACTUAL position after a
   * warp/click, read from the SAME source (cliclick) that checkpoint()'s
   * activity guard uses. `intended` is where the caller AIMED the cursor; it is
   * only a fallback (used if the live read fails) and the reference for
   * detecting an ineffective warp.
   *
   * Why this exists (root cause of the 2026-07-18..22 false "activity" aborts):
   * the old code recorded the INTENDED point. If the warp landed anywhere else —
   * Retina/multi-display coord skew, or (the confirmed case) a warp that never
   * moved the cursor because the launchd daemon lacks the Accessibility TCC grant
   * that posting HID events needs (Screen Recording is a *separate* grant) — the
   * next checkpoint compared the live cursor against a point it was never at and
   * cried "user activity", every single scan. Recording the ACTUAL position keeps
   * baseline and comparison in one coordinate space, so that can't happen; a
   * genuine user move is still caught because it lands AFTER this readback.
   *
   * @returns {Promise<number|null>} px deviation between intended and actual
   *   (null if either is unavailable). A large deviation means the warp/click did
   *   not take effect — callers surface it instead of silently degrading.
   */
  async recordActualCursor(intended) {
    const actual = await this.readCursor(); // {x,y} | null, via cliclick p (no extra TCC grant to READ)
    const aim =
      typeof intended === 'string'
        ? parseCursor(intended)
        : intended && Number.isFinite(intended.x) && Number.isFinite(intended.y)
          ? { x: intended.x, y: intended.y }
          : null;
    this.recordCursor(actual || aim); // prefer ACTUAL; fall back to intended only if the read failed
    return actual && aim ? Math.round(cursorDistance(actual, aim)) : null;
  }

  /**
   * Mandatory gate before every screenshot / cliclick / scroll. Throws ScanAbort
   * (sentinel > deadline > activity) if the scan must stop. Cheap (one cliclick p).
   */
  async checkpoint() {
    if (!this.enabled) return;
    this._checkSentinel();
    this._checkDeadlines();
    await this._checkActivity();
  }

  /** Count one scroll iteration; enforce the per-stage hard cap. */
  tickScroll() {
    if (!this.enabled) return;
    this.scrollCount += 1;
    if (this.scrollCount > this.cfg.scrollMax) {
      throw new ScanAbort('scroll-cap', this.phase, this._scopeForPhase(this.phase));
    }
    if (this.cfg.progressEvery > 0 && this.scrollCount % this.cfg.progressEvery === 0) {
      this.progress(`stage=${this.phase} scroll=${this.scrollCount}/${this.cfg.scrollMax}`);
    }
  }

  progress(msg) {
    try {
      process.stderr.write(`[scan] ${msg}\n`);
    } catch {
      /* ignore */
    }
  }

  elapsedMs() {
    return Date.now() - this.startedAt;
  }
}

// A no-op controller so scan-engine functions work in unit tests / callers that
// never initialized control (all guards become inert, nothing throws).
const NOOP = {
  enabled: false,
  cfg: resolveConfig(),
  enterPhase() {},
  recordCursor() {},
  async recordActualCursor() {
    return null;
  },
  async checkpoint() {},
  tickScroll() {},
  progress() {},
  elapsedMs() {
    return 0;
  },
};

let _active = NOOP;

/** Initialize (or reset) the singleton controller and clear any stale sentinel. */
export function initScanControl(opts = {}) {
  clearAbortSentinel();
  _active = new ScanController(resolveConfig(opts), opts.readCursor);
  return _active;
}

/** Current controller (NOOP if never initialized). */
export function getScanControl() {
  return _active;
}

/** For tests: build a controller without touching the singleton or the sentinel. */
export function createScanController(opts = {}) {
  return new ScanController(resolveConfig(opts), opts.readCursor);
}
