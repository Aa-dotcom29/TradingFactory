'use strict';

// Angel One quote mapping. Pure functions, so no network, credentials or broker is involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAngelTime, toQuotePayload } = require('../src/sources/angel-quote');

// The exchange timestamps in the documented FULL response are `DD-MMM-YYYY HH:mm:ss` in IST.
const FULL_QUOTE = {
  exchange: 'NSE',
  tradingSymbol: 'SBIN-EQ',
  symbolToken: '3045',
  ltp: 568.2,
  open: 567.4,
  high: 569.35,
  low: 566.1,
  close: 567.4,
  lastTradeQty: 1,
  exchFeedTime: '21-Jun-2023 10:46:10',
  exchTradeTime: '21-Jun-2023 10:46:09',
  tradeVolume: 3556150,
  opnInterest: 0,
};

test('parseAngelTime reads the exchange format as IST, not the host timezone', () => {
  // 10:46:10 IST is 05:16:10 UTC.
  assert.equal(parseAngelTime('21-Jun-2023 10:46:10'), '2023-06-21T05:16:10.000Z');
  assert.equal(parseAngelTime('01-Jan-2026 00:00:00'), '2025-12-31T18:30:00.000Z');
});

test('parseAngelTime passes an ISO value through and refuses anything else', () => {
  assert.equal(parseAngelTime('2026-10-14T05:00:00.000Z'), '2026-10-14T05:00:00.000Z');
  assert.equal(parseAngelTime(''), null);
  assert.equal(parseAngelTime(undefined), null);
  assert.equal(parseAngelTime('not a date'), null);
  assert.equal(parseAngelTime('21-Foo-2023 10:46:10'), null);
});

test('toQuotePayload maps the FULL quote and stamps the exchange feed time', () => {
  const payload = toQuotePayload(FULL_QUOTE);
  assert.equal(payload.ltp, 568.2);
  assert.equal(payload.open, 567.4);
  assert.equal(payload.high, 569.35);
  assert.equal(payload.low, 566.1);
  assert.equal(payload.close, 567.4);
  // Angel reports an open interest of 0 for every equity; the mapper keeps it as null.
  assert.equal(payload.openInterest, null);
  assert.equal(payload.volume, 3556150);
  assert.equal(payload.exchange, 'NSE');
  assert.equal(payload.quoteTime, '2023-06-21T05:16:10.000Z');
});

test('toQuotePayload falls back to the trade time and tolerates a bare response', () => {
  const noFeed = { ...FULL_QUOTE, exchFeedTime: undefined };
  assert.equal(toQuotePayload(noFeed).quoteTime, '2023-06-21T05:16:09.000Z');

  const noTimes = { ltp: 100, close: 99 };
  const payload = toQuotePayload(noTimes);
  assert.equal(payload.quoteTime, null);
  assert.equal(payload.exchange, 'NSE');
  assert.equal(payload.openInterest, null);
});
