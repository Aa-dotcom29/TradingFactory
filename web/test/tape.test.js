import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateFootprint, priceBucketFor, normaliseDepth, depthImbalanceSeries, tapeRead,
} from '../lib/tape.js';

const at = (minute) => `2026-10-21T04:${String(minute).padStart(2, '0')}:00.000Z`;

test('priceBucketFor keeps index and stock footprints readable', () => {
  assert.equal(priceBucketFor(24000), 10);
  assert.equal(priceBucketFor(5000), 5);
  assert.equal(priceBucketFor(3000), 1);
  assert.equal(priceBucketFor(250), 0.5);
  assert.equal(priceBucketFor(25), 0.05);
  assert.equal(priceBucketFor(2), 0.01);
});

test('aggregateFootprint groups prints into bars and price levels', () => {
  const analysis = aggregateFootprint([
    { captured_at: at(0), ltp: '100.10', volume_delta: '100', side: 'BUY' },
    { captured_at: at(0), ltp: '100.10', volume_delta: '40', side: 'SELL' },
    { captured_at: at(0), ltp: '100.50', volume_delta: '25', side: 'BUY' },
    { captured_at: at(1), ltp: '100.10', volume_delta: '10', side: 'BUY' },
    { captured_at: at(1), ltp: '100.50', volume_delta: '5', side: 'SELL' },
  ], { bucket: 0.5, maxBars: 12, maxLevels: 14 });

  assert.equal(analysis.bucket, 0.5);
  assert.equal(analysis.bars.length, 2);
  assert.equal(analysis.totals.buy, 135);
  assert.equal(analysis.totals.sell, 45);
  assert.equal(analysis.totals.delta, 90);
  assert.equal(analysis.totals.volume, 180);
  assert.equal(analysis.totals.prints, 5);
  assert.equal(analysis.rows.length, 2);
  assert.equal(analysis.rows[0].price, 100.5);
  assert.equal(analysis.rows[0].buy, 25);
  assert.equal(analysis.rows[0].sell, 5);
  assert.equal(analysis.rows[1].price, 100);
  assert.equal(analysis.rows[1].buy, 110);
  assert.equal(analysis.rows[1].sell, 40);
});

test('aggregateFootprint keeps unsided volume out of delta', () => {
  const analysis = aggregateFootprint([
    { captured_at: at(0), ltp: '100', volume_delta: '50', side: 'UNKNOWN' },
    { captured_at: at(0), ltp: '100', volume_delta: '20', side: 'BUY' },
  ], { bucket: 1 });
  assert.equal(analysis.totals.unknown, 50);
  assert.equal(analysis.totals.delta, 20);
  assert.equal(analysis.totals.volume, 70);
});

test('aggregateFootprint falls back to last_qty when the cumulative series is absent', () => {
  const analysis = aggregateFootprint([
    { captured_at: at(0), ltp: '100', last_qty: '15', side: 'SELL' },
  ], { bucket: 1 });
  assert.equal(analysis.totals.sell, 15);
  assert.equal(analysis.totals.prints, 1);
});

test('normaliseDepth accepts JSONB arrays and strings', () => {
  const fromArray = normaliseDepth({
    levels: 2,
    bids: [{ price: '100.4', quantity: '300', orders: '2' }],
    asks: [{ price: '100.6', quantity: '200', orders: '1' }],
  });
  assert.equal(fromArray.bestBid, 100.4);
  assert.equal(fromArray.bestAsk, 100.6);
  assert.equal(fromArray.bidQty, 300);
  assert.equal(fromArray.askQty, 200);
  assert.ok(Math.abs(fromArray.imbalance - 100 / 500) < 1e-9);
  assert.ok(Math.abs(fromArray.spread - 0.2) < 1e-9);

  const fromString = normaliseDepth({
    bids: JSON.stringify([{ price: 10, quantity: 5 }]),
    asks: JSON.stringify([{ price: 11, quantity: 5 }]),
  });
  assert.equal(fromString.bestBid, 10);
  assert.equal(fromString.bestAsk, 11);
});

test('depthImbalanceSeries ignores missing values and tapeRead is factual', () => {
  assert.deepEqual(depthImbalanceSeries([
    { imbalance: '0.2' }, { imbalance: null }, { imbalance: '-0.1' },
  ]), [0.2, -0.1]);
  assert.equal(tapeRead({ delta: 100, imbalance: 0.2 }), 'BUYERS IN CONTROL');
  assert.equal(tapeRead({ delta: -100, imbalance: -0.2 }), 'SELLERS IN CONTROL');
  assert.equal(tapeRead({ delta: 100, imbalance: 0 }), 'BUYERS ACTIVE');
  assert.equal(tapeRead({ delta: 0, imbalance: 0 }), 'BALANCED');
});
