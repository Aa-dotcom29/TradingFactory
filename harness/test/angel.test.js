'use strict';

// Angel One quote mapping plus the client's login preflight. The mapping is pure and the client
// test stubs global.fetch, so neither touches the network or a real broker account.
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { AngelClient } = require('../src/sources/angel-client');
const { parseAngelTime, toQuotePayload, toAngelExpiry } = require('../src/sources/angel-quote');

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

test('toAngelExpiry formats the optionGreek body the way Angel expects', () => {
  assert.equal(toAngelExpiry('2026-10-19'), '19OCT2026');
  assert.equal(toAngelExpiry('2026-10-19T00:00:00Z'), '19OCT2026');
  assert.equal(toAngelExpiry('25JAN2024'), '25JAN2024');
  assert.equal(toAngelExpiry('25jan2024'), '25JAN2024');
  assert.equal(toAngelExpiry(''), null);
  assert.equal(toAngelExpiry(undefined), null);
  assert.equal(toAngelExpiry('not a date'), null);
  assert.equal(toAngelExpiry('2026-13-01'), null);
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

// Regression: the constructor's public-IP cache field used to be named `publicIp`, which shadowed
// the `publicIp()` method and made `login()` throw "this.publicIp is not a function" on the very
// first line. This runs the real login path against a stubbed fetch so the whole flow is covered.
test('AngelClient.publicIp is callable and login resolves an IP then stores the token', async () => {
  const client = new AngelClient();
  assert.equal(typeof client.publicIp, 'function', 'publicIp() must not be shadowed by a field');

  const saved = { ...config.angel };
  const originalFetch = global.fetch;
  const calls = [];
  try {
    config.angel.clientId = 'TESTCLIENT';
    config.angel.apiKey = 'TESTKEY';
    config.angel.password = '1234';
    config.angel.totpSecret = 'JBSWY3DPEHPK3PXP';

    global.fetch = async (url, options) => {
      calls.push({ url: String(url), headers: options?.headers || {} });
      if (String(url).includes('ipify')) return { text: async () => '203.0.113.9\n' };
      return { ok: true, status: 200, json: async () => ({ status: true, data: { jwtToken: 'jwt-token', feedToken: 'feed-token' } }) };
    };

    const result = await client.login();
    assert.equal(result.accessToken, 'jwt-token');
    assert.equal(result.feedToken, 'feed-token');

    const loginCall = calls.find((c) => c.url.includes('/loginByPassword'));
    assert.ok(loginCall, 'login must POST to the SmartAPI login endpoint');
    // The resolved public IP must travel on the login request, not the local fallback.
    assert.equal(loginCall.headers['X-ClientPublicIP'], '203.0.113.9');
  } finally {
    global.fetch = originalFetch;
    config.angel.clientId = saved.clientId;
    config.angel.apiKey = saved.apiKey;
    config.angel.password = saved.password;
    config.angel.totpSecret = saved.totpSecret;
  }
});
