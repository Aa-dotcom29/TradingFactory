'use strict';

// Slice 5.5 - Yahoo Finance as the free fallback quote source.
//
// The harness needs a previous close and a last price for every tracked name, because that is
// what the bias meter's `price` component reads. Angel One is the authoritative live feed, but a
// household that has not finished the broker onboarding would otherwise run with no quote at all
// and every verdict would be neutral. Yahoo covers that gap with no key, no account and no cost.
//
// Two things are non-negotiable here:
//
//   1. Provenance is recorded on every row. Yahoo's NSE quotes are delayed (roughly 15 minutes
//      intraday), so a delayed read must never be presented as a live one - the value travels
//      with the quote as `provenance: 'yahoo-delayed'` and the dashboard renders it.
//   2. One failing symbol never fails the batch. The caller gets per-symbol errors back and can
//      report them honestly rather than pretending the quote exists.
//
// The endpoint is the public chart API, which returns the same numbers the Yahoo site shows:
// regularMarketPrice (last), chartPreviousClose (previous session close), the day's high/low and
// a market timestamp. No parse of the web page, no scraping of HTML.

const config = require('../config');
const log = require('../logger').child({ module: 'yahoo' });

const PROVENANCE = 'yahoo-delayed';
const PROVIDER = 'Yahoo Finance (NSE, delayed)';

// Yahoo uses index tickers, not the NSE trading symbols, so the two index names the harness
// tracks have to be mapped explicitly. Equities are simply suffixed with `.NS`.
const INDEX_SYMBOLS = {
  NIFTY: '^NSEI',
  BANKNIFTY: '^NSEBANK',
  MIDCPNIFTY: '^NSEMDCP50',
  FINNIFTY: '^CNXFIN',
};

function yahooSymbol(symbol) {
  const key = String(symbol || '').trim().toUpperCase();
  if (!key) return null;
  return INDEX_SYMBOLS[key] || `${key.replace(/\s+/g, '')}.NS`;
}

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstFinite(candidates) {
  for (const value of Array.isArray(candidates) ? candidates : []) {
    const n = num(value);
    if (n !== null) return n;
  }
  return null;
}

function lastFinite(series) {
  if (!Array.isArray(series)) return null;
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const n = num(series[i]);
    if (n !== null) return n;
  }
  return null;
}

function extreme(series, pick) {
  const numbers = (Array.isArray(series) ? series : []).map(num).filter((n) => n !== null);
  if (!numbers.length) return null;
  return pick(numbers);
}

// Exposed for tests: turns a raw chart response into the bounded `quote.v1` shape W0 persists.
function parseChart(json, symbol) {
  const result = json && json.chart && Array.isArray(json.chart.result) ? json.chart.result[0] : null;
  if (!result || !result.meta) return null;
  const meta = result.meta;
  const bars = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};

  const ltp = firstFinite([meta.regularMarketPrice, lastFinite(bars.close)]);
  const close = firstFinite([meta.chartPreviousClose, meta.previousClose]);
  if (ltp === null || close === null) return null;

  const marketTime = num(meta.regularMarketTime);

  return {
    symbol,
    yahooSymbol: meta.symbol || null,
    ltp,
    open: firstFinite([meta.regularMarketOpen, firstFinite(bars.open)]),
    high: firstFinite([meta.regularMarketDayHigh, extreme(bars.high, (n) => Math.max(...n))]),
    low: firstFinite([meta.regularMarketDayLow, extreme(bars.low, (n) => Math.min(...n))]),
    close,
    volume: firstFinite([meta.regularMarketVolume, lastFinite(bars.volume)]),
    exchange: 'NSE',
    currency: meta.currency || 'INR',
    quoteTime: marketTime === null ? null : new Date(marketTime * 1000).toISOString(),
    provenance: PROVENANCE,
    provider: PROVIDER,
  };
}

async function fetchQuote(symbol, options = {}) {
  const ysym = yahooSymbol(symbol);
  if (!ysym) {
    return { symbol, error: 'no Yahoo symbol mapping', provenance: PROVENANCE };
  }

  const doFetch = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (typeof doFetch !== 'function') {
    return { symbol, yahooSymbol: ysym, error: 'no fetch implementation available', provenance: PROVENANCE };
  }

  const timeoutMs = options.timeoutMs || config.yahoo.timeoutMs;
  const url = `${config.yahoo.apiRoot}/v8/finance/chart/${encodeURIComponent(ysym)}`
    + `?range=${encodeURIComponent(config.yahoo.range)}&interval=${encodeURIComponent(config.yahoo.interval)}`;

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await doFetch(url, {
      headers: { accept: 'application/json', 'user-agent': config.yahoo.userAgent },
      signal: controller ? controller.signal : undefined,
    });
    if (!response || !response.ok) {
      throw new Error(`HTTP ${response ? response.status : 'no response'}`);
    }
    const parsed = parseChart(await response.json(), symbol);
    if (!parsed) throw new Error('chart response carried no usable quote');
    return parsed;
  } catch (error) {
    return {
      symbol,
      yahooSymbol: ysym,
      error: error.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : error.message,
      provenance: PROVENANCE,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Sequential with a small gap: this is a free endpoint with no key and no published quota, and
// the universe is small, so there is no reason to hammer it.
async function fetchQuotes(symbols, options = {}) {
  const spacingMs = options.spacingMs === undefined ? config.yahoo.spacingMs : options.spacingMs;
  const wanted = (Array.isArray(symbols) ? symbols : []).filter(Boolean);
  const quotes = [];
  const errors = [];

  for (let i = 0; i < wanted.length; i += 1) {
    const quote = await fetchQuote(wanted[i], options);
    if (quote.error) errors.push({ symbol: quote.symbol, error: quote.error });
    else quotes.push(quote);
    if (spacingMs > 0 && i < wanted.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, spacingMs));
    }
  }

  if (errors.length) {
    log.warn('some Yahoo quotes failed', { failed: errors.length, total: wanted.length });
  }
  return { quotes, errors };
}

module.exports = {
  PROVENANCE,
  PROVIDER,
  INDEX_SYMBOLS,
  yahooSymbol,
  parseChart,
  fetchQuote,
  fetchQuotes,
};
