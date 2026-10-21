import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBars, biasFromBars, alignmentOf, timeframeRead, bucketKey,
  LTF_MINUTES, HTF_MINUTES, ALIGNMENT_LOOKBACK, INDEX_SYMBOLS,
} from '../lib/timeframe.js';

const base = Date.UTC(2026, 0, 2, 3, 0, 0); // a Friday, 03:00 UTC

function quote(at, ltp) {
  return { at: new Date(at).toISOString(), ltp };
}

test('bucketKey snaps a timestamp to the bar it belongs to', () => {
  assert.equal(bucketKey(new Date(base).toISOString(), 5), Math.floor(base / 300000) * 300000);
  assert.equal(bucketKey(new Date(base).toISOString(), 15), Math.floor(base / 900000) * 900000);
  assert.equal(bucketKey('not a date', 5), null);
});

test('buildBars keeps the first and last print of each bar', () => {
  const rows = [
    quote(base, 100),
    quote(base + 1000, 101),
    quote(base + 2000, 99),
    quote(base + 290000, 105), // same 5m bar
    quote(base + 300000, 110), // next bar
  ];
  const bars = buildBars(rows, 5);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].open, 100);
  assert.equal(bars[0].close, 105);
  assert.equal(bars[0].high, 105);
  assert.equal(bars[0].low, 99);
  assert.equal(bars[0].samples, 4);
  assert.equal(bars[1].open, 110);
  assert.equal(bars[1].close, 110);
});

test('buildBars ignores rows without a usable price', () => {
  const rows = [quote(base, 'x'), { at: null, ltp: 10 }, quote(base, 100)];
  const bars = buildBars(rows, 5);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].open, 100);
});

test('biasFromBars refuses to call a direction without enough bars', () => {
  const read = biasFromBars([]);
  assert.equal(read.status, 'UNAVAILABLE');
  assert.equal(read.direction, 'FLAT');
  assert.equal(read.changePct, null);
  assert.ok(read.reason);
});

test('biasFromBars reads an up move and a down move', () => {
  const up = biasFromBars([
    { at: 0, open: 100, close: 100, high: 100, low: 100, samples: 1 },
    { at: 1, open: 100, close: 103, high: 103, low: 100, samples: 1 },
    { at: 2, open: 103, close: 106, high: 106, low: 103, samples: 1 },
  ]);
  assert.equal(up.status, 'OK');
  assert.equal(up.direction, 'UP');
  assert.ok(up.changePct > 0);

  const down = biasFromBars([
    { at: 0, open: 100, close: 100, high: 100, low: 100, samples: 1 },
    { at: 1, open: 100, close: 98, high: 100, low: 98, samples: 1 },
    { at: 2, open: 98, close: 95, high: 98, low: 95, samples: 1 },
  ]);
  assert.equal(down.direction, 'DOWN');
  assert.ok(down.changePct < 0);
});

test('biasFromBars calls a tiny move flat rather than a direction', () => {
  const read = biasFromBars([
    { at: 0, open: 100, close: 100, high: 100, low: 100, samples: 1 },
    { at: 1, open: 100, close: 100.01, high: 100.01, low: 100, samples: 1 },
    { at: 2, open: 100.01, close: 100.005, high: 100.01, low: 100, samples: 1 },
  ]);
  assert.equal(read.direction, 'FLAT');
  assert.equal(read.status, 'OK');
});

test('alignmentOf separates agreement from disagreement', () => {
  const aligned = alignmentOf({ status: 'OK', direction: 'UP' }, { status: 'OK', direction: 'UP' });
  assert.equal(aligned.aligned, true);
  assert.equal(aligned.label, 'ALIGNED');
  assert.equal(aligned.tone, 'up');

  const diverged = alignmentOf({ status: 'OK', direction: 'UP' }, { status: 'OK', direction: 'DOWN' });
  assert.equal(diverged.aligned, false);
  assert.equal(diverged.label, 'DIVERGED');
  assert.equal(diverged.tone, 'warn');
});

test('alignmentOf refuses to align a flat or missing timeframe', () => {
  const flat = alignmentOf({ status: 'OK', direction: 'FLAT' }, { status: 'OK', direction: 'UP' });
  assert.equal(flat.aligned, null);
  assert.equal(flat.label, 'FLAT');

  const missing = alignmentOf({ status: 'UNAVAILABLE', direction: 'FLAT' }, { status: 'OK', direction: 'UP' });
  assert.equal(missing.aligned, null);
  assert.equal(missing.label, 'UNAVAILABLE');
});

test('timeframeRead reports both timeframes and the verdict', () => {
  // A steady climb: one print every minute for 30 minutes.
  const rows = [];
  for (let i = 0; i < 30; i += 1) {
    rows.push(quote(base + i * 60000, 100 + i));
  }
  const read = timeframeRead(rows, base + 29 * 60000);
  assert.equal(read.ltf.minutes, LTF_MINUTES);
  assert.equal(read.htf.minutes, HTF_MINUTES);
  assert.equal(read.ltf.status, 'OK');
  assert.equal(read.htf.status, 'OK');
  assert.equal(read.ltf.direction, 'UP');
  assert.equal(read.htf.direction, 'UP');
  assert.equal(read.alignment.label, 'ALIGNED');
  assert.equal(read.quotes, 30);
  assert.ok(read.ageMs >= 0);
});

test('timeframeRead reports a divergence when the short timeframe turns down', () => {
  const rows = [];
  // Twenty minutes of climbing, then a fifteen-minute fall. The last three
  // 5-minute bars are down while the last three 15-minute bars are still up.
  for (let i = 0; i < 20; i += 1) {
    rows.push(quote(base + i * 60000, 100 + i));
  }
  for (let i = 20; i < 35; i += 1) {
    rows.push(quote(base + i * 60000, 120 - (i - 20)));
  }
  const read = timeframeRead(rows, base + 34 * 60000);
  assert.equal(read.ltf.direction, 'DOWN');
  assert.equal(read.htf.direction, 'UP');
  assert.equal(read.alignment.label, 'DIVERGED');
  assert.equal(read.alignment.tone, 'warn');
});

test('timeframeRead with no quotes is unavailable, not flat', () => {
  const read = timeframeRead([], base);
  assert.equal(read.ltf.status, 'UNAVAILABLE');
  assert.equal(read.htf.status, 'UNAVAILABLE');
  assert.equal(read.alignment.label, 'UNAVAILABLE');
  assert.equal(read.quotes, 0);
  assert.equal(read.ageMs, null);
});

test('timeframeRead sorts rows before folding them', () => {
  const rows = [
    quote(base + 360000, 106),
    quote(base, 100),
    quote(base + 60000, 101),
    quote(base + 120000, 102),
    quote(base + 180000, 103),
    quote(base + 240000, 104),
    quote(base + 300000, 105),
  ];
  const read = timeframeRead(rows, base + 360000);
  assert.equal(read.ltf.open, 100);
  assert.equal(read.ltf.close, 106);
});

test('the alignment window and index list are the ones the UI assumes', () => {
  assert.equal(ALIGNMENT_LOOKBACK, 3);
  // The list is shared with the tradable book, so the order lives in one place.
  assert.deepEqual(INDEX_SYMBOLS, ['NIFTY', 'BANKNIFTY', 'MIDCPNIFTY', 'SENSEX']);
});
