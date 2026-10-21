import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExpiry, optionContractKey, computeMomentum, computeTradePnl,
  computeTheta, findContract, sparklinePoints, nearestSampleIndex,
} from '../lib/trade.js';

test('parseExpiry accepts the shapes the harness and NSE use', () => {
  assert.equal(parseExpiry('27-Oct-2026'), '2026-10-27');
  assert.equal(parseExpiry('27OCT2026'), '2026-10-27');
  assert.equal(parseExpiry('2026-10-27'), '2026-10-27');
  assert.equal(parseExpiry('not-a-date'), null);
});

test('optionContractKey matches the option.quote.v1 identity', () => {
  assert.equal(
    optionContractKey({
      symbol: 'NIFTY 50', expiry: '27-Oct-2026', strike: 23100, optionType: 'CE',
    }),
    'NIFTY|2026-10-27|23100|CE',
  );
  assert.equal(
    optionContractKey({
      symbol: 'BANK NIFTY', expiry: '27OCT2026', strike: '56200', optionType: 'call',
    }),
    'BANKNIFTY|2026-10-27|56200|CE',
  );
  assert.equal(optionContractKey({ symbol: 'NIFTY', expiry: null, strike: 23100, optionType: 'CE' }), null);
});

test('computeMomentum reports the path window honestly', () => {
  const result = computeMomentum([
    { at: '2026-10-21T04:00:00Z', ltp: 100 },
    { at: '2026-10-21T04:05:00Z', ltp: 110 },
    { at: '2026-10-21T04:10:00Z', ltp: 105 },
  ]);
  assert.equal(result.samples, 3);
  assert.equal(result.windowMinutes, 10);
  assert.equal(result.high, 110);
  assert.equal(result.low, 100);
  assert.equal(result.changePct, 5);
  assert.equal(result.rangePosition, 50);
});

test('computeTradePnl handles long and short positions', () => {
  const long = computeTradePnl({
    position: 'LONG', entry: 100, current: 110, stop: 95, target: 120,
  });
  assert.equal(long.available, true);
  assert.equal(long.pnl, 10);
  assert.equal(long.pnlPct, 10);
  assert.equal(long.rMultiple, 2);
  assert.equal(long.progressToTarget, 0.5);

  const short = computeTradePnl({
    position: 'SHORT', entry: 100, current: 90, stop: 105, target: 80,
  });
  assert.equal(short.pnl, 10);
  assert.equal(short.rMultiple, 2);
  assert.ok(Math.abs(short.toTargetPct - 11.1111) < 0.01);
});

test('computeTheta separates intrinsic and extrinsic value', () => {
  const theta = computeTheta({
    premium: 140,
    spot: 23034,
    strike: 23100,
    optionType: 'CE',
    expiry: '2026-10-27',
    now: new Date('2026-10-20T10:00:00Z'),
  });
  assert.equal(theta.available, true);
  assert.equal(theta.dte, 7);
  assert.equal(theta.intrinsic, 0);
  assert.equal(theta.extrinsic, 140);
  assert.equal(theta.thetaPerDay, 20);
  assert.equal(theta.extrinsicPct, 100);
});

test('findContract normalises NSE Call/Put labels', () => {
  const match = findContract([
    { strike: 23100, expiry: '27-Oct-2026', optionType: 'Call', price: 139.95 },
  ], { strike: '23100', expiry: '27OCT2026', optionType: 'CE' });
  assert.equal(match.price, 139.95);
});

test('sparklinePoints needs at least two samples', () => {
  assert.equal(sparklinePoints([{ ltp: 100 }]), '');
  const points = sparklinePoints([{ ltp: 100 }, { ltp: 110 }], 10, 10);
  assert.equal(points, '0.0,10.0 10.0,0.0');
});

test('nearestSampleIndex snaps a pointer to a real sample and clamps at the edges', () => {
  assert.equal(nearestSampleIndex(0, 5), 0);
  assert.equal(nearestSampleIndex(1, 5), 4);
  assert.equal(nearestSampleIndex(0.5, 5), 2);
  assert.equal(nearestSampleIndex(-3, 5), 0);
  assert.equal(nearestSampleIndex(9, 5), 4);
  assert.equal(nearestSampleIndex(0.4, 3), 1);
  assert.equal(nearestSampleIndex(0.2, 3), 0);
});

test('nearestSampleIndex never returns an index without samples', () => {
  assert.equal(nearestSampleIndex(0.5, 0), -1);
  assert.equal(nearestSampleIndex(0.5, -1), -1);
  assert.equal(nearestSampleIndex(0.5, 'x'), -1);
  assert.equal(nearestSampleIndex(0.5, 1), 0);
  assert.equal(nearestSampleIndex(NaN, 4), 0);
});
