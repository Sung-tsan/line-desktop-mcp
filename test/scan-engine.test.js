// scan-engine.test.js — GUI-free tests for the pure helpers in scan-engine.
// Run: node --test test/scan-engine.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { roomHeaderMatch, normalizeChatName, roomNameScore, roomNameMatches } from '../src/scan/scan-engine.js';

test('roomHeaderMatch: exact + OCR-noisy header lines match the target room', () => {
  // exact
  assert.equal(roomHeaderMatch(['陳董 × 迪威智能'], '陳董 × 迪威智能'), true);
  // header carries extra chrome around the name (contains)
  assert.equal(roomHeaderMatch(['< 陳董 × 迪威智能 (4)', '搜尋'], '陳董 × 迪威智能'), true);
  // half/full-width + separator variants normalize to the same key
  assert.equal(roomHeaderMatch(['陳董 x 迪威智能'], '陳董 × 迪威智能'), true);
});

test('roomHeaderMatch: wrong room / desktop / sidebar text does NOT match', () => {
  assert.equal(roomHeaderMatch(['鄭董和迪威'], '陳董 × 迪威智能'), false); // different room open
  assert.equal(roomHeaderMatch(['全部', '好友', '群組'], '陳董 × 迪威智能'), false); // still on the sidebar
  assert.equal(roomHeaderMatch([], '陳董 × 迪威智能'), false); // captured nothing (blank/desktop)
  assert.equal(roomHeaderMatch(['Finder', '桌面'], '陳董 × 迪威智能'), false);
});

test('roomHeaderMatch: empty/garbage target is never a match (no trivial true)', () => {
  assert.equal(roomHeaderMatch(['anything'], ''), false);
  assert.equal(roomHeaderMatch(['anything'], '   '), false);
  // a 1-2 char header fragment must not swallow a long target via target.includes(n)
  assert.equal(roomHeaderMatch(['迪'], '陳董 × 迪威智能'), false);
  assert.equal(normalizeChatName('陳董 × 迪威智能（4）'), normalizeChatName('陳董 x 迪威智能'));
});

test('roomNameMatches: same room across OCR jitter still matches (locate by enumerate name)', () => {
  // whitespace/separator drift between enumerate-time and read-time OCR
  assert.equal(roomNameMatches('陳董 × 迪威智能', '陳董 ×迪威智能'), true);
  assert.equal(roomNameMatches('adi15數位新創交流群（51）', 'adi15 數位新創交流群 (51)'), true);
  assert.equal(roomNameScore('陳董 × 迪威智能', '陳董 × 迪威智能'), 1); // exact -> 1
});

test('roomNameMatches: different rooms do NOT match (no wrong-room clicks)', () => {
  assert.equal(roomNameMatches('黃偉祐 Martin（偉嘉）', 'Kelly小伶'), false);
  assert.equal(roomNameMatches('adi15數位新創交流群', '汪劭穎'), false);
  assert.equal(roomNameMatches('', '陳董 × 迪威智能'), false); // empty -> never
  // a short name must not fuzzily swallow an unrelated long one
  assert.ok(roomNameScore('群組', '黃偉祐 Martin 偉嘉群組') < 0.6);
});
