'use strict';

// Angel One SmartAPI REST client for the harness. Reuses the proven TOTP generator from the
// existing feed module instead of reimplementing auth, and adds the endpoints the harness
// needs: batched quotes, the instrument master, and the option-Greek endpoint.
//
// The existing angel-feed.js already owns WebSocket streaming for the live dashboard; this
// client is the polling/ingestion path used by the harness workers.

const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');
const log = require('../logger').child({ module: 'angel' });
const { makeTotp } = require('../../../angel-feed.js');
const { toAngelExpiry } = require('./angel-quote');

const INDEX_MATCHERS = [
  { name: 'NIFTY 50', match: ['NIFTY 50'], exchangeType: 1 },
  { name: 'BANK NIFTY', match: ['NIFTY BANK', 'BANK NIFTY'], exchangeType: 1 },
  { name: 'MIDCAP NIFTY', match: ['NIFTY MID SELECT', 'NIFTY MIDCAP SELECT', 'MIDCAP NIFTY'], exchangeType: 1 },
];

function configured() {
  return config.angel.configured();
}

function networkIdentity() {
  let local = '127.0.0.1';
  let mac = '00:00:00:00:00:00';
  for (const rows of Object.values(os.networkInterfaces())) {
    for (const row of rows || []) {
      if (!row.internal && row.family === 'IPv4') {
        local = row.address;
        mac = row.mac || mac;
        return { local, mac };
      }
    }
  }
  return { local, mac };
}

class RateLimiter {
  constructor(perSecond) {
    this.interval = Math.ceil(1000 / Math.max(0.1, perSecond));
    this.last = 0;
  }

  async wait() {
    const delay = this.interval - (Date.now() - this.last);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    this.last = Date.now();
  }
}

class AngelClient {
  constructor() {
    this.accessToken = '';
    this.feedToken = '';
    // Renamed from publicIp so it does not shadow the publicIp() method below.
    this.resolvedPublicIp = '';
    this.instruments = null;
    this.instrumentsPromise = null;
    this.lastError = null;
    this.limiter = new RateLimiter(config.angel.maxPerSecond);
  }

  baseHeaders() {
    const identity = networkIdentity();
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-PrivateKey': config.angel.apiKey,
      'X-ClientLocalIP': identity.local,
      'X-ClientPublicIP': this.resolvedPublicIp || identity.local,
      'X-MACAddress': identity.mac,
    };
  }

  authHeaders() {
    return { ...this.baseHeaders(), Authorization: `Bearer ${this.accessToken}` };
  }

  async publicIp() {
    if (this.resolvedPublicIp) return this.resolvedPublicIp;
    try {
      const response = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) });
      const ip = (await response.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) this.resolvedPublicIp = ip;
    } catch (error) {
      log.warn('public IP lookup failed; falling back to local IP', { error: error.message });
    }
    return this.resolvedPublicIp;
  }

  async request(url, options) {
    await this.limiter.wait();
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(config.angel.timeoutMs) });
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(`Angel One returned an unreadable response (HTTP ${response.status})`);
    }
    if (!response.ok || body.status !== true) {
      throw new Error(body.message || body.errorMessage || `Angel One request failed (HTTP ${response.status})`);
    }
    return body;
  }

  async login() {
    if (!configured()) throw new Error('Angel One credentials are not configured');
    await this.publicIp();
    const body = await this.request(`${config.angel.apiRoot}/rest/auth/angelbroking/user/v1/loginByPassword`, {
      method: 'POST',
      headers: this.baseHeaders(),
      body: JSON.stringify({
        clientcode: config.angel.clientId,
        password: config.angel.password,
        totp: makeTotp(config.angel.totpSecret),
      }),
    });
    this.accessToken = body.data?.jwtToken || '';
    this.feedToken = body.data?.feedToken || '';
    if (!this.accessToken) throw new Error('Angel One login succeeded without an access token');
    this.lastError = null;
    log.info('angel one login ok');
    return { accessToken: this.accessToken, feedToken: this.feedToken };
  }

  async ensureInstruments() {
    if (this.instruments) return this.instruments;
    // Two quote paths (the underlying universe and the held option contracts) can ask for the
    // master in the same cycle. Sharing the in-flight download keeps that to one request instead
    // of two 35 MB downloads; a failure clears it so the next cycle retries.
    if (!this.instrumentsPromise) {
      this.instrumentsPromise = (async () => {
        const cacheFile = path.join(config.root, 'harness', 'data', 'angel-instruments.json');
        const maxAgeMs = Math.max(1, config.angel.scripMasterCacheHours) * 3600 * 1000;
        try {
          const stat = await fs.stat(cacheFile);
          if (Date.now() - stat.mtimeMs <= maxAgeMs) {
            const rows = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
            if (Array.isArray(rows) && rows.length) {
              log.info('instrument master loaded from cache', { rows: rows.length, cacheFile });
              this.instruments = rows;
              return rows;
            }
          }
        } catch (error) {
          if (error.code !== 'ENOENT') log.warn('instrument master cache unreadable; downloading', { error: error.message });
        }

        const response = await fetch(config.angel.scripMasterUrl, {
          signal: AbortSignal.timeout(config.angel.scripMasterTimeoutMs),
        });
        if (!response.ok) throw new Error(`Could not download instrument master (HTTP ${response.status})`);
        const rows = await response.json();
        if (!Array.isArray(rows) || !rows.length) throw new Error('Instrument master was empty');
        log.info('instrument master downloaded', { rows: rows.length });
        this.instruments = rows;
        try {
          await fs.mkdir(path.dirname(cacheFile), { recursive: true });
          await fs.writeFile(cacheFile, JSON.stringify(rows), 'utf8');
        } catch (error) {
          log.warn('could not cache instrument master', { error: error.message });
        }
        return rows;
      })();
    }
    try {
      return await this.instrumentsPromise;
    } catch (error) {
      this.instrumentsPromise = null;
      throw error;
    }
  }

  resolveIndexTokens() {
    const rows = (this.instruments || []).filter(
      (r) => String(r.exch_seg).toUpperCase() === 'NSE' && String(r.instrumenttype).toUpperCase() === 'AMXIDX',
    );
    return INDEX_MATCHERS.map((index) => {
      const row = rows.find((r) =>
        index.match.some((name) => String(r.name || '').trim().toUpperCase() === name || String(r.symbol || '').trim().toUpperCase() === name),
      );
      if (!row) return null;
      return { name: index.name, token: String(row.token), exchangeType: index.exchangeType };
    }).filter(Boolean);
  }

  // Equity symbol -> NSE token, for the configured equity universe.
  resolveEquityTokens(symbols) {
    const rows = (this.instruments || []).filter((r) => String(r.exch_seg).toUpperCase() === 'NSE' && String(r.symbol).endsWith('-EQ'));
    return symbols
      .map((symbol) => {
        const row = rows.find((r) => String(r.symbol).toUpperCase() === `${symbol.toUpperCase()}-EQ`);
        return row ? { name: symbol, token: String(row.token) } : null;
      })
      .filter(Boolean);
  }

  // Batched quote call. Angel One accepts many tokens per request, so we batch per exchange.
  async quote(mode, tokensByExchange) {
    if (!this.accessToken) await this.login();
    const body = await this.request(`${config.angel.apiRoot}/rest/secure/angelbroking/market/v1/quote/`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({ mode, exchangeTokens: tokensByExchange }),
    });
    return body.data?.fetched || [];
  }

  async optionGreeks(name, expiryDate) {
    if (!this.accessToken) await this.login();
    // The endpoint rejects ISO with "Invalid expiry date"; it wants DDMMMYYYY.
    const expiry = toAngelExpiry(expiryDate);
    if (!expiry) throw new Error(`Could not read an option expiry from "${expiryDate}"`);
    const body = await this.request(`${config.angel.apiRoot}/rest/secure/angelbroking/marketData/v1/optionGreek`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({ name, expirydate: expiry }),
    });
    return body.data || [];
  }

  status() {
    if (!configured()) return { state: 'NOT_CONFIGURED', detail: 'Angel One credentials missing' };
    if (this.lastError) return { state: 'ERROR', detail: this.lastError };
    if (this.accessToken) return { state: 'READY', detail: 'Authenticated for REST polling' };
    return { state: 'IDLE', detail: 'Not authenticated yet' };
  }
}

module.exports = { AngelClient, configured, INDEX_MATCHERS };
