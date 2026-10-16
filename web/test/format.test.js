import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compact,
  num,
  pct,
  signed,
  isNum,
  readTone,
  sentimentTone,
  severityTone,
  directionTone,
  istStamp,
  timeAgo,
} from '../lib/format.js';

test('compact uses Indian lakh/crore units', () => {
  assert.equal(compact(2500), '2.5K');
  assert.equal(compact(1500000), '15.00L');
  assert.equal(compact(12345678), '1.23Cr');
  assert.equal(compact(-97000), '-97.0K');
  assert.equal(compact(null), '-');
});

test('missing values render as "-" rather than 0', () => {
  assert.equal(compact(null), '-');
  assert.equal(num(null), '-');
  assert.equal(pct(undefined), '-');
  assert.equal(signed(''), '-');
  assert.equal(isNum(null), false);
  assert.equal(isNum(''), false);
  assert.equal(isNum(0), true);
  assert.equal(num(0), '0');
});

test('pct and signed add explicit direction', () => {
  assert.equal(pct(3.456), '+3.5%');
  assert.equal(pct(-2), '-2.0%');
  assert.equal(signed(1500), '+1,500');
  assert.equal(signed(-42), '-42');
});

test('readTone maps build-up quadrants to colour tones', () => {
  assert.equal(readTone('LONG BUILDUP'), 'up');
  assert.equal(readTone('SHORT COVERING'), 'up');
  assert.equal(readTone('SHORT BUILDUP'), 'down');
  assert.equal(readTone('LONG UNWINDING'), 'down');
  assert.equal(readTone('NO CHANGE'), 'muted');
});

test('sentiment, severity and direction tones', () => {
  assert.equal(sentimentTone(0.9), 'up');
  assert.equal(sentimentTone(-0.5), 'down');
  assert.equal(sentimentTone(0.1), 'muted');
  assert.equal(severityTone('CRITICAL'), 'down');
  assert.equal(severityTone('HIGH'), 'warn');
  assert.equal(directionTone('BULLISH'), 'up');
  assert.equal(directionTone('BEARISH'), 'down');
});

test('istStamp renders in Asia/Kolkata, not local time', () => {
  // 10:00 UTC is 15:30 IST.
  const out = istStamp('2026-10-16T10:00:00.000Z');
  assert.match(out, /15:30/);
  assert.match(out, /Oct/);
});

test('timeAgo produces coarse buckets and handles bad input', () => {
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  assert.equal(timeAgo(ago(30 * 1000)), '30s ago');
  assert.equal(timeAgo(ago(90 * 60 * 1000)), '1h ago');
  assert.equal(timeAgo(ago(48 * 60 * 60 * 1000)), '2d ago');
  assert.equal(timeAgo('not-a-date'), '-');
});

test('formatters stay ASCII (no mojibake)', () => {
  const samples = [compact(12345678), pct(1.2), signed(5), istStamp('2026-10-16T10:00:00Z')];
  for (const s of samples) assert.match(s, /^[\x20-\x7E]+$/);
});
