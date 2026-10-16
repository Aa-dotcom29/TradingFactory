'use strict';

// NSE public data reader: cookie primed, throttled, retried once on auth failure.
// NSE guards its JSON APIs behind cookies + browser-ish headers, so we prime a session by
// loading the site once and reuse the cookie for subsequent calls.
//
// IMPORTANT: this is enrichment/fallback, never the primary feed. If NSE blocks us the
// pipeline must keep running on the broker feed alone. Endpoint paths can change over time,
// so each path is tried from a small candidate list.

const config = require('../config');
const log = require('../logger').child({ module: 'nse' });

const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-IN,en;q=0.9',
  referer: `${config.nse.baseUrl}/`,
};

let cookies = '';
let lastRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle() {
  const wait = config.nse.minIntervalMs - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

async function prime() {
  const response = await fetch(`${config.nse.baseUrl}/`, {
    headers: { ...BROWSER_HEADERS, accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(config.nse.timeoutMs),
  });
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
  cookies = setCookies.map((c) => c.split(';')[0]).join('; ');
  return response.ok;
}

async function getJson(path, { retry = true } = {}) {
  if (!cookies) await prime();
  await throttle();
  const response = await fetch(`${config.nse.baseUrl}${path}`, {
    headers: { ...BROWSER_HEADERS, ...(cookies ? { cookie: cookies } : {}) },
    signal: AbortSignal.timeout(config.nse.timeoutMs),
  });
  if ((response.status === 401 || response.status === 403 || response.status === 404) && retry) {
    cookies = '';
    await prime();
    return getJson(path, { retry: false });
  }
  if (!response.ok) throw new Error(`NSE ${path} responded HTTP ${response.status}`);
  return response.json();
}

async function tryPaths(paths) {
  let lastError;
  for (const path of paths) {
    try {
      return await getJson(path);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('NSE: no candidate path succeeded');
}

function toNumber(value) {
  const n = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// OI spurts answer "where is open interest moving unusually fast" - our volume-flow read.
async function fetchOiSpurts() {
  if (!config.nse.enabled) return { underlyings: [], contracts: [] };
  const result = { underlyings: [], contracts: [] };
  const capturedAt = new Date().toISOString();

  try {
    const raw = await tryPaths(config.nse.oiSpurtsPaths.underlyings);
    const rows = Array.isArray(raw) ? raw : raw?.data || [];
    result.underlyings = rows.map((r) => ({
      capturedAt,
      scope: 'UNDERLYING',
      symbol: r.symbol || r.underlying || r.Underlying || null,
      oi: toNumber(r.openInterest ?? r.OI ?? r.latestOI),
      oiChange: toNumber(r.changeinOpenInterest ?? r.OIchg ?? r.oiChange),
      volume: toNumber(r.volume ?? r.totalTradedVolume),
      price: toNumber(r.lastPrice ?? r.ltp ?? r.underlyingValue),
      priceChangePct: toNumber(r.pChange ?? r.perChange ?? r.priceChangePct),
      contract: null,
      payload: r,
    }));
  } catch (error) {
    log.warn('OI spurts (underlyings) unavailable', { error: error.message });
  }

  try {
    const raw = await tryPaths(config.nse.oiSpurtsPaths.contracts);
    const rows = Array.isArray(raw) ? raw : raw?.data || [];
    result.contracts = rows.map((r) => ({
      capturedAt,
      scope: 'CONTRACT',
      symbol: r.underlying || r.symbol || null,
      contract: r.contract || r.symbol || null,
      oi: toNumber(r.openInterest ?? r.OI ?? r.latestOI),
      oiChange: toNumber(r.changeinOpenInterest ?? r.OIchg ?? r.oiChange),
      volume: toNumber(r.volume ?? r.totalTradedVolume),
      price: toNumber(r.lastPrice ?? r.ltp),
      priceChangePct: toNumber(r.pChange ?? r.perChange),
      payload: r,
    }));
  } catch (error) {
    log.warn('OI spurts (contracts) unavailable', { error: error.message });
  }

  return result;
}

function spurtScore(row) {
  const oiChange = Math.abs(row.oiChange || 0);
  const volume = row.volume || 0;
  const priceMove = Math.abs(row.priceChangePct || 0);
  return Math.round(oiChange * Math.log10(1 + volume) * (1 + priceMove / 100));
}

async function fetchOptionChain(kind, symbol) {
  if (!config.nse.enabled) return null;
  const base = kind === 'index' ? config.nse.optionChainPaths.index : config.nse.optionChainPaths.equity;
  return getJson(`${base}${encodeURIComponent(symbol)}`);
}

module.exports = { fetchOiSpurts, fetchOptionChain, spurtScore, prime, getJson };
