'use strict';

// Slice 5.5 - the Yahoo fallback quote source. Pure parsing plus a fetch that is always injected,
// so these run with no network and no credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PROVENANCE,
  PROVIDER,
  yahooSymbol,
  parseChart,
  fetchQuote,
  fetchQuotes,
} = require('../src/sources/yahoo');

const MARKET_TIME = 1792144867;

function chart(meta = {}, bars = {}) {
  return {
    chart: {
      result: [{
        meta: {
          symbol: '^NSEI',
          currency: 'INR',
          exchangeName: 'NSI',
          regularMarketPrice: 23146.15,
          chartPreviousClose: 22622.7,
          regularMarketDayHigh: 23149.85,
          regularMarketDayLow: 22913.8,
          regularMarketTime: MARKET_TIME,
          ...meta,
        },
        indicators: { quote: [{ open: [22900], high: [22920.5], low: [22880.25], close: [23100], volume: [1234], ...bars }] },
      }],
    },
  };
}

const okFetch = (payload) => async () => ({ ok: true, status: 200, json: async () => payload });

test('yahooSymbol maps the tracked indices and suffixes equities', () => {
  assert.equal(yahooSymbol('NIFTY'), '^NSEI');
  assert.equal(yahooSymbol('banknifty'), '^NSEBANK');
  assert.equal(yahooSymbol('MIDCPNIFTY'), '^NSEMDCP50');
  assert.equal(yahooSymbol('RELIANCE'), 'RELIANCE.NS');
  assert.equal(yahooSymbol(' reliance '), 'RELIANCE.NS');
  assert.equal(yahooSymbol(''), null);
  assert.equal(yahooSymbol(null), null);
});

test('parseChart reads last price, previous close and the day range from meta', () => {
  const quote = parseChart(chart(), 'NIFTY');
  assert.equal(quote.symbol, 'NIFTY');
  assert.equal(quote.yahooSymbol, '^NSEI');
  assert.equal(quote.ltp, 23146.15);
  assert.equal(quote.close, 22622.7);
  assert.equal(quote.high, 23149.85);
  assert.equal(quote.low, 22913.8);
  assert.equal(quote.open, 22900);
  assert.equal(quote.exchange, 'NSE');
  assert.equal(quote.currency, 'INR');
  assert.equal(quote.provenance, PROVENANCE);
  assert.equal(quote.provider, PROVIDER);
});

test('parseChart stamps the exchange time so a delayed read can be aged', () => {
  const quote = parseChart(chart(), 'NIFTY');
  assert.equal(quote.quoteTime, new Date(MARKET_TIME * 1000).toISOString());
  assert.equal(parseChart(chart({ regularMarketTime: undefined }), 'NIFTY').quoteTime, null);
});

test('parseChart falls back to the bar series when meta omits the range', () => {
  const quote = parseChart(chart({
    regularMarketDayHigh: undefined,
    regularMarketDayLow: undefined,
  }, { high: [23100, null, 23150.25], low: [22900, 22880.5, null] }), 'NIFTY');
  assert.equal(quote.high, 23150.25);
  assert.equal(quote.low, 22880.5);
});

test('parseChart falls back to previousClose and rejects a response with no usable numbers', () => {
  const viaPrev = parseChart(chart({ chartPreviousClose: undefined, previousClose: 22600 }), 'NIFTY');
  assert.equal(viaPrev.close, 22600);

  assert.equal(parseChart(null, 'NIFTY'), null);
  assert.equal(parseChart({ chart: {} }, 'NIFTY'), null);
  assert.equal(parseChart(chart({ regularMarketPrice: undefined }, { close: [null] }), 'NIFTY'), null);
  assert.equal(parseChart(chart({ chartPreviousClose: undefined }), 'NIFTY'), null);
});

test('fetchQuote returns a parsed quote and always carries provenance', async () => {
  const quote = await fetchQuote('NIFTY', { fetchImpl: okFetch(chart()), timeoutMs: 1000 });
  assert.equal(quote.ltp, 23146.15);
  assert.equal(quote.provenance, PROVENANCE);
  assert.equal(quote.error, undefined);
});

test('fetchQuote reports an HTTP failure instead of throwing', async () => {
  const quote = await fetchQuote('NIFTY', {
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }),
    timeoutMs: 1000,
  });
  assert.equal(quote.error, 'HTTP 429');
  assert.equal(quote.provenance, PROVENANCE);
});

test('fetchQuote reports a timeout as a timeout rather than a generic error', async () => {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  const quote = await fetchQuote('NIFTY', {
    fetchImpl: async () => { throw abort; },
    timeoutMs: 250,
  });
  assert.equal(quote.error, 'timed out after 250ms');
});

test('fetchQuote reports a malformed payload rather than inventing a price', async () => {
  const quote = await fetchQuote('NIFTY', {
    fetchImpl: okFetch({ chart: { result: [] } }),
    timeoutMs: 1000,
  });
  assert.equal(quote.error, 'chart response carried no usable quote');
});

test('fetchQuotes keeps the good symbols when one fails', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('TCS')) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => chart() };
  };
  const { quotes, errors } = await fetchQuotes(['NIFTY', 'TCS', 'RELIANCE'], {
    fetchImpl, timeoutMs: 1000, spacingMs: 0,
  });
  assert.equal(quotes.length, 2);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].symbol, 'TCS');
  assert.equal(quotes.every((q) => q.provenance === PROVENANCE), true);
});

test('fetchQuotes on an empty universe makes no request at all', async () => {
  let called = 0;
  const { quotes, errors } = await fetchQuotes([], {
    fetchImpl: async () => { called += 1; return { ok: true, status: 200, json: async () => chart() }; },
    spacingMs: 0,
  });
  assert.equal(called, 0);
  assert.deepEqual(quotes, []);
  assert.deepEqual(errors, []);
});
