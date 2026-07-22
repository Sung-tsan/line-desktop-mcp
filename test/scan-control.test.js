// scan-control.test.js — GUI-free verification of the scanner safety spine.
// Run: node --test test/scan-control.test.js
//
// Covers the four hardening guarantees without ever touching the mouse/screen:
//   - abort sentinel stops at the next checkpoint
//   - layered watchdog (total / stage / scroll-cap) trips + labels the stage
//   - live cursor-activity detection (via an injected read-cursor stub)
//   - the pure cursor wrappers (parse + moved-beyond)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createScanController,
  parseCursor,
  cursorDistance,
  cursorMovedBeyond,
  ScanAbort,
  isFatalAbort,
  writeAbortSentinel,
  clearAbortSentinel,
  abortSentinelExists,
} from '../src/scan/scan-control.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A cursor reader that never reports movement (returns whatever the ctl parked).
const stillCursor = (ctl) => async () => ctl.lastPlaced || { x: 0, y: 0 };

test('parseCursor handles valid, negative, and malformed input', () => {
  assert.deepEqual(parseCursor('1105,615'), { x: 1105, y: 615 });
  assert.deepEqual(parseCursor(' -3,-9 \n'), { x: -3, y: -9 });
  assert.equal(parseCursor('garbage'), null);
  assert.equal(parseCursor(''), null);
  assert.equal(parseCursor('1,2,3'), null);
});

test('cursorMovedBeyond: tolerance, no-baseline, and read-failure semantics', () => {
  assert.equal(cursorDistance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  // within tolerance -> not moved
  assert.equal(cursorMovedBeyond({ x: 105, y: 205 }, { x: 100, y: 200 }, 10), false);
  // beyond tolerance -> moved (the user is back)
  assert.equal(cursorMovedBeyond({ x: 140, y: 260 }, { x: 100, y: 200 }, 10), true);
  // no baseline yet -> cannot judge, never trips
  assert.equal(cursorMovedBeyond({ x: 9, y: 9 }, null, 10), false);
  // read failure (null cur) -> don't false-trip
  assert.equal(cursorMovedBeyond(null, { x: 100, y: 200 }, 10), false);
});

test('watchdog: total-timeout trips at next checkpoint, labelled stage=total, fatal', async () => {
  const ctl = createScanController({ totalMs: 40, chatMs: 999999, readCursor: async () => null });
  await ctl.checkpoint(); // immediately: not yet expired
  await sleep(60);
  const err = await ctl.checkpoint().then(() => null, (e) => e);
  assert.ok(err instanceof ScanAbort, 'threw ScanAbort');
  assert.equal(err.reason, 'timeout');
  assert.equal(err.phase, 'total');
  assert.equal(err.scope, 'scan');
  assert.equal(isFatalAbort(err), true);
});

test('watchdog: per-stage timeout labels the stage; chat scope is recoverable', async () => {
  const ctl = createScanController({ totalMs: 999999, readCursor: async () => null });
  ctl.enterPhase('chat:Acme 群組', 30);
  await sleep(50);
  const err = await ctl.checkpoint().then(() => null, (e) => e);
  assert.ok(err instanceof ScanAbort);
  assert.equal(err.reason, 'timeout');
  assert.equal(err.phase, 'chat:Acme 群組');
  assert.equal(err.scope, 'chat', 'a single chat timeout is recoverable, not fatal');
  assert.equal(isFatalAbort(err), false);
});

test('watchdog: scroll-iteration hard cap trips tickScroll', () => {
  const ctl = createScanController({ scrollMax: 3, progressEvery: 0 });
  ctl.enterPhase('enumerate');
  ctl.tickScroll();
  ctl.tickScroll();
  ctl.tickScroll(); // 3 == cap, still ok
  const err = (() => { try { ctl.tickScroll(); return null; } catch (e) { return e; } })();
  assert.ok(err instanceof ScanAbort);
  assert.equal(err.reason, 'scroll-cap');
  assert.equal(err.phase, 'enumerate');
  assert.equal(err.scope, 'scan');
  // entering a new stage resets the scroll budget
  ctl.enterPhase('chat:x');
  assert.doesNotThrow(() => ctl.tickScroll());
});

test('abort sentinel: checkpoint stops as soon as the file exists', async () => {
  clearAbortSentinel();
  const ctl = createScanController({ totalMs: 999999 });
  ctl.recordCursor({ x: 50, y: 50 });
  ctl.readCursor = stillCursor(ctl); // no activity, isolate the sentinel path
  await ctl.checkpoint(); // clean: no throw
  writeAbortSentinel('unit-test');
  try {
    assert.equal(abortSentinelExists(), true);
    const err = await ctl.checkpoint().then(() => null, (e) => e);
    assert.ok(err instanceof ScanAbort);
    assert.equal(err.reason, 'sentinel');
    assert.equal(err.scope, 'scan');
    assert.equal(isFatalAbort(err), true);
  } finally {
    clearAbortSentinel();
  }
  assert.equal(abortSentinelExists(), false);
});

test('activity guard: checkpoint trips when the live cursor leaves the parked spot', async () => {
  clearAbortSentinel();
  let where = { x: 100, y: 100 };
  const ctl = createScanController({ totalMs: 999999, cursorTolerancePx: 10, readCursor: async () => where });
  ctl.recordCursor({ x: 100, y: 100 }); // script parked the cursor here
  await ctl.checkpoint(); // cursor still there -> ok
  where = { x: 400, y: 300 }; // user grabbed the mouse
  const err = await ctl.checkpoint().then(() => null, (e) => e);
  assert.ok(err instanceof ScanAbort);
  assert.equal(err.reason, 'activity');
  assert.equal(err.scope, 'scan');
});

test('mock engine loop: sentinel breaks a scroll loop at the next checkpoint', async () => {
  // Stand-in for enumerateAllChats's scroll loop: prove a running loop actually
  // stops when the sentinel appears, rather than running to its page cap.
  clearAbortSentinel();
  const ctl = createScanController({ totalMs: 999999, scrollMax: 999, progressEvery: 0 });
  ctl.enterPhase('enumerate');
  ctl.readCursor = stillCursor(ctl);
  let iterations = 0;
  const err = await (async () => {
    try {
      for (let page = 0; page < 40; page++) {
        await ctl.checkpoint(); // gate before each "scroll"
        ctl.tickScroll();
        iterations++;
        if (page === 4) writeAbortSentinel('mid-loop'); // sentinel appears mid-run
      }
      return null;
    } catch (e) {
      return e;
    }
  })();
  clearAbortSentinel();
  assert.ok(err instanceof ScanAbort);
  assert.equal(err.reason, 'sentinel');
  assert.ok(iterations >= 5 && iterations < 40, `stopped mid-loop after ${iterations} (not the 40 cap)`);
});

test('activity abort carries diagnostic evidence (recorded/observed/distance/tolerance/source)', async () => {
  // Regression for the 2026-07-18..22 blind spot: the abort JSON was a bare
  // {reason:'activity'} with no way to tell a false trip from a real one.
  clearAbortSentinel();
  let where = { x: 100, y: 100 };
  const ctl = createScanController({ totalMs: 999999, cursorTolerancePx: 10, readCursor: async () => where });
  ctl.recordCursor({ x: 100, y: 100 });
  await ctl.checkpoint();
  where = { x: 400, y: 300 };
  const err = await ctl.checkpoint().then(() => null, (e) => e);
  assert.ok(err instanceof ScanAbort);
  assert.equal(err.reason, 'activity');
  assert.ok(err.evidence, 'evidence is attached');
  assert.deepEqual(err.evidence.recorded, { x: 100, y: 100 });
  assert.deepEqual(err.evidence.observed, { x: 400, y: 300 });
  assert.equal(err.evidence.tolerancePx, 10);
  assert.equal(err.evidence.distancePx, Math.round(Math.hypot(300, 200)));
  assert.equal(err.evidence.source, 'cliclick');
});

test('recordActualCursor parks the baseline on the ACTUAL cursor, not the intended point', async () => {
  // Root-cause regression: warp AIMED at the LINE window but the cursor actually
  // sits where the user left it (warp landed elsewhere, or never fired). The old
  // code recorded the INTENDED point and every next checkpoint cried "activity".
  clearAbortSentinel();
  let where = { x: -802, y: 605 }; // user's real cursor (untouched)
  const ctl = createScanController({ totalMs: 999999, cursorTolerancePx: 10, readCursor: async () => where });
  const dev = await ctl.recordActualCursor({ x: 250, y: 420 }); // we aimed here; cursor is really at `where`
  assert.deepEqual(ctl.lastPlaced, { x: -802, y: 605 }, 'baseline is the ACTUAL cursor, not the intended target');
  assert.equal(dev, Math.round(Math.hypot(-802 - 250, 605 - 420)), 'returns the aim-vs-actual deviation');
  await ctl.checkpoint(); // cursor unchanged since the (actual) baseline -> NO false activity
  // ...but a genuine subsequent user move is still caught.
  where = { x: 900, y: 900 };
  const err = await ctl.checkpoint().then(() => null, (e) => e);
  assert.ok(err instanceof ScanAbort);
  assert.equal(err.reason, 'activity');
});

test('recordActualCursor falls back to the intended point when the live read fails', async () => {
  clearAbortSentinel();
  const ctl = createScanController({ totalMs: 999999, readCursor: async () => null });
  const dev = await ctl.recordActualCursor({ x: 12, y: 34 });
  assert.deepEqual(ctl.lastPlaced, { x: 12, y: 34 }, 'no live read -> keep the intended baseline');
  assert.equal(dev, null, 'no deviation reported when actual is unknown');
});
