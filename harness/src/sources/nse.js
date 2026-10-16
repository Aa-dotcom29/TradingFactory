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

// Local ASCII classifier. Deliberately NOT reusing angel-feed's classifyPriceOi because that
// module's separator characters are double-encoded, which would leak mojibake into stored data.
function classifyFlow(priceChangePct, oiChange) {
  if (priceChangePct == null || oiChange == null) return 'FIRST SAMPLE';
  if (priceChangePct === 0 && oiChange === 0) return 'NO CHANGE';
  if (oiChange === 0) return 'PRICE MOVED / OI FLAT';
  if (priceChangePct === 0) return 'OI CHANGED / PRICE FLAT';
  if (oiChange > 0) return priceChangePct > 0 ? 'LONG BUILDUP' : 'SHORT BUILDUP';
  return priceChangePct > 0 ? 'SHORT COVERING' : 'LONG UNWINDING';
}

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
//
// NSE shapes (verified live 2026-10-16):
//   underlyings -> array of { symbol, latestOI, prevOI, changeInOI, volume, underlyingValue, ... }
//   contracts   -> one or more objects keyed by build-up bucket, each holding an array of rows:
//                  "Rise-in-OI-Rise" (long buildup), "Rise-in-OI-Slide" (short buildup),
//                  "Slide-in-OI-Rise" (short covering), "Slide-in-OI-Slide" (long unwinding).
//                  Each row: { identifier, symbol, latestOI, changeInOI, volume, ltp, pChange,
//                              optionType, strikePrice, expiryDate, underlyingValue, ... }
function mapUnderlying(r, capturedAt) {
  return {
    capturedAt,
    scope: 'UNDERLYING',
    symbol: r.symbol || null,
    contract: null,
    oi: toNumber(r.latestOI ?? r.openInterest),
    oiChange: toNumber(r.changeInOI ?? r.changeinOpenInterest),
    volume: toNumber(r.volume),
    price: toNumber(r.underlyingValue ?? r.lastPrice),
    priceChangePct: toNumber(r.pChange),
    read: classifyFlow(toNumber(r.pChange), toNumber(r.changeInOI)),
    optionType: null,
    strike: null,
    expiry: null,
    bucket: null,
    payload: r,
  };
}

function mapContract(r, capturedAt, bucket) {
  const oiChange = toNumber(r.changeInOI);
  const priceChangePct = toNumber(r.pChange);
  return {
    capturedAt,
    scope: 'CONTRACT',
    symbol: r.symbol || null,
    contract: r.identifier || null,
    oi: toNumber(r.latestOI),
    oiChange,
    volume: toNumber(r.volume),
    price: toNumber(r.ltp),
    priceChangePct,
    read: classifyFlow(priceChangePct, oiChange),
    optionType: r.optionType && r.optionType !== '-' ? r.optionType : null,
    strike: toNumber(r.strikePrice) || null,
    expiry: r.expiryDate || null,
    bucket: bucket || (r.type ? `type:${r.type}` : null),
    payload: r,
  };
}

// Normalizes the several shapes NSE may return for the contracts endpoint into one flat row
// list. Live shape is { data: [ {bucket: rows}, ... ], timestamp, currTradingDate, ... }.
function flattenContractBuckets(raw) {
  const out = [];
  const containers = Array.isArray(raw)
    ? raw
    : (raw && Array.isArray(raw.data) ? raw.data : [raw]);
  for (const container of containers) {
    if (!container || typeof container !== 'object') continue;
    for (const [bucket, list] of Object.entries(container)) {
      if (!Array.isArray(list)) continue;
      for (const row of list) out.push({ bucket, row });
    }
  }
  return out;
}

async function fetchOiSpurts() {
  if (!config.nse.enabled) return { underlyings: [], contracts: [] };
  const result = { underlyings: [], contracts: [] };
  const capturedAt = new Date().toISOString();

  try {
    const raw = await tryPaths(config.nse.oiSpurtsPaths.underlyings);
    const rows = Array.isArray(raw) ? raw : raw?.data || [];
    result.underlyings = rows.map((r) => mapUnderlying(r, capturedAt));
  } catch (error) {
    log.warn('OI spurts (underlyings) unavailable', { error: error.message });
  }

  try {
    const raw = await tryPaths(config.nse.oiSpurtsPaths.contracts);
    result.contracts = flattenContractBuckets(raw).map(({ bucket, row }) => mapContract(row, capturedAt, bucket));
  } catch (error) {
    log.warn('OI spurts (contracts) unavailable', { error: error.message });
  }

  return result;
}

// Rank by how much open interest moved, scaled by how much it was traded. Sign is dropped
// because both fresh build-up and aggressive unwinding are "flow worth looking at".
function spurtScore(row) {
  const oiChange = Math.abs(row.oiChange || 0);
  const volume = row.volume || 0;
  return Math.round(oiChange * Math.log10(1 + volume));
}

async function fetchOptionChain(kind, symbol) {
  if (!config.nse.enabled) return null;
  const base = kind === 'index' ? config.nse.optionChainPaths.index : config.nse.optionChainPaths.equity;
  return getJson(`${base}${encodeURIComponent(symbol)}`);
}

module.exports = { fetchOiSpurts, fetchOptionChain, spurtScore, classifyFlow, flattenContractBuckets, prime, getJson };
