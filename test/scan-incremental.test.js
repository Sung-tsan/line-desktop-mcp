// scan-incremental.test.js — GUI-free verification of the incremental-scan
// decision logic (sidebar-marker parsing + skip rule). Run:
//   node --test test/scan-incremental.test.js
//
// Pure functions only: no screenshots, no cursor, no filesystem. A fixed `now`
// is injected so weekday / cross-year / time-of-day math is deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveSidebarMarker,
  shouldSkipRoom,
  shouldAdvanceWatermark,
  INCREMENTAL_MARGIN_MS,
} from '../src/scan/state.js';

// Reference "now": 2026-07-14 10:00 local (a Tuesday, but tests derive weekday
// from now.getDay() so they don't depend on that fact).
const NOW = new Date(2026, 6, 14, 10, 0, 0, 0);

test('resolveSidebarMarker: bare HH:MM => today at that time', () => {
  const d = resolveSidebarMarker('09:47', NOW);
  assert.ok(d instanceof Date);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 6);
  assert.equal(d.getDate(), 14);
  assert.equal(d.getHours(), 9);
  assert.equal(d.getMinutes(), 47);
});

test('resolveSidebarMarker: 下午 3:24 => today 15:24 (PM adds 12)', () => {
  const d = resolveSidebarMarker('下午 3:24', NOW);
  assert.equal(d.getDate(), 14);
  assert.equal(d.getHours(), 15);
  assert.equal(d.getMinutes(), 24);
});

test('resolveSidebarMarker: 上午 12:05 => 00:05 (midnight); 下午 12:30 => 12:30 (noon)', () => {
  assert.equal(resolveSidebarMarker('上午 12:05', NOW).getHours(), 0);
  assert.equal(resolveSidebarMarker('下午 12:30', NOW).getHours(), 12);
});

test('resolveSidebarMarker: 昨天 => yesterday 23:59', () => {
  const d = resolveSidebarMarker('昨天', NOW);
  assert.equal(d.getDate(), 13);
  assert.equal(d.getHours(), 23);
  assert.equal(d.getMinutes(), 59);
});

test('resolveSidebarMarker: 星期三 => most recent PAST Wednesday, 23:59', () => {
  const d = resolveSidebarMarker('星期三', NOW);
  assert.equal(d.getDay(), 3, 'is a Wednesday');
  assert.ok(d.getTime() < NOW.getTime(), 'strictly in the past');
  const daysAgo = (NOW.getTime() - d.getTime()) / 86400000;
  assert.ok(daysAgo >= 0 && daysAgo <= 7, `within the last 7 days (was ${daysAgo.toFixed(2)})`);
  assert.equal(d.getHours(), 23);
  assert.equal(d.getMinutes(), 59);
});

test('resolveSidebarMarker: 6月30日 => this year Jun 30 23:59 (already past)', () => {
  const d = resolveSidebarMarker('6月30日', NOW);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 5); // June
  assert.equal(d.getDate(), 30);
  assert.equal(d.getHours(), 23);
  assert.equal(d.getMinutes(), 59);
});

test('resolveSidebarMarker: cross-year — parsing 12月31日 in early Jan => last year', () => {
  const earlyJan = new Date(2026, 0, 3, 10, 0, 0); // 2026-01-03
  const d = resolveSidebarMarker('12月31日', earlyJan);
  assert.equal(d.getFullYear(), 2025, 'Dec 31 this year is in the future => last year');
  assert.equal(d.getMonth(), 11);
  assert.equal(d.getDate(), 31);
});

test('resolveSidebarMarker: garbage / empty / non-timestamp => null', () => {
  assert.equal(resolveSidebarMarker('亂碼☺︎xyz', NOW), null);
  assert.equal(resolveSidebarMarker('', NOW), null);
  assert.equal(resolveSidebarMarker(null, NOW), null);
  assert.equal(resolveSidebarMarker('在線中', NOW), null);
  assert.equal(resolveSidebarMarker('99:99', NOW), null); // matches shape but out of range
});

test('shouldSkipRoom: no watermark => never skip (full scan)', () => {
  assert.equal(shouldSkipRoom('昨天', null, NOW), false);
  assert.equal(shouldSkipRoom('昨天', '', NOW), false);
});

test('shouldSkipRoom: marker clearly older than watermark => skip', () => {
  const lastSuccess = NOW.toISOString(); // 10:00 today
  assert.equal(shouldSkipRoom('昨天', lastSuccess, NOW), true);
  assert.equal(shouldSkipRoom('09:00', lastSuccess, NOW), true); // 09:00 < 09:30 cutoff
});

test('shouldSkipRoom: marker newer than watermark => scan', () => {
  const lastSuccess = NOW.toISOString(); // 10:00 today, cutoff 09:30
  assert.equal(shouldSkipRoom('09:50', lastSuccess, NOW), false);
});

test('shouldSkipRoom: safety margin keeps boundary rooms in (fail-safe)', () => {
  const lastSuccess = NOW.toISOString(); // cutoff = 09:30 (10:00 - 30min)
  assert.equal(INCREMENTAL_MARGIN_MS, 30 * 60 * 1000);
  assert.equal(shouldSkipRoom('09:45', lastSuccess, NOW), false, '09:45 is inside the 30-min margin => scan');
  assert.equal(shouldSkipRoom('09:29', lastSuccess, NOW), true, '09:29 is just past the margin => skip');
});

test('shouldSkipRoom: unparseable marker fails open (scan, never lose messages)', () => {
  const lastSuccess = NOW.toISOString();
  assert.equal(shouldSkipRoom('在線中', lastSuccess, NOW), false);
  assert.equal(shouldSkipRoom('', lastSuccess, NOW), false);
});

test('shouldAdvanceWatermark: broken input path (all reads empty, 0 verified opens) => HOLD', () => {
  // 2026-07-22 signature: clicks dropped under launchd => 7 rooms all read 0.
  assert.equal(
    shouldAdvanceWatermark({ aborted: null, pushAdvance: true, scanned: 7, totalNew: 0, verifiedOpens: 0 }),
    false
  );
});

test('shouldAdvanceWatermark: quiet day with working clicks (verified opens, 0 new) => ADVANCE', () => {
  // incremental must NOT be permanently defeated when reads genuinely work.
  assert.equal(
    shouldAdvanceWatermark({ aborted: null, pushAdvance: true, scanned: 7, totalNew: 0, verifiedOpens: 7 }),
    true
  );
});

test('shouldAdvanceWatermark: new messages found => ADVANCE (even if some opens unverified)', () => {
  assert.equal(
    shouldAdvanceWatermark({ aborted: null, pushAdvance: true, scanned: 5, totalNew: 12, verifiedOpens: 0 }),
    true
  );
});

test('shouldAdvanceWatermark: nothing read (all incrementally skipped) => ADVANCE', () => {
  assert.equal(
    shouldAdvanceWatermark({ aborted: null, pushAdvance: true, scanned: 0, totalNew: 0, verifiedOpens: 0 }),
    true
  );
});

test('shouldAdvanceWatermark: abort or held push => HOLD regardless', () => {
  assert.equal(
    shouldAdvanceWatermark({ aborted: { reason: 'activity' }, pushAdvance: true, scanned: 3, totalNew: 9, verifiedOpens: 3 }),
    false
  );
  assert.equal(
    shouldAdvanceWatermark({ aborted: null, pushAdvance: false, scanned: 3, totalNew: 9, verifiedOpens: 3 }),
    false
  );
});
