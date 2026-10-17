const os = require('node:os');
const crypto = require('node:crypto');
const WebSocket = require('ws');

const API_ROOT = 'https://apiconnect.angelone.in';
const SCRIP_MASTER = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
const INDEXES = [
  { name: 'NIFTY 50', match: ['NIFTY 50', 'NIFTY 50'], exchangeType: 1 },
  { name: 'BANK NIFTY', match: ['NIFTY BANK', 'BANK NIFTY'], exchangeType: 1 },
  { name: 'MIDCAP NIFTY', match: ['NIFTY MID SELECT', 'NIFTY MIDCAP SELECT', 'MIDCAP NIFTY'], exchangeType: 1 },
];

function nseDerivativesSession(at = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map(p => [p.type, p.value]));
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const weekday = !['Sat', 'Sun'].includes(parts.weekday);
  const phase = !weekday ? 'CLOSED_DAY' : minute < 555 ? 'PRE_MARKET' : minute < 940 ? 'SESSION' : 'POST_MARKET';
  return { phase, localTime: `${parts.hour}:${parts.minute}`, weekday };
}

function base32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(value || '').toUpperCase().replace(/=+$/g, '').replace(/\s/g, '');
  let bits = '';
  for (const ch of clean) {
    const n = alphabet.indexOf(ch);
    if (n < 0) throw new Error('ANGEL_TOTP_SECRET must be a base32 authenticator key.');
    bits += n.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function makeTotp(secret, at = Date.now()) {
  const counter = Math.floor(at / 30000);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', base32(secret)).update(msg).digest();
  const offset = digest[digest.length - 1] & 15;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(code).padStart(6, '0');
}

function classifyPriceOi(priceChange, oiChange) {
  if (priceChange == null || oiChange == null) return 'FIRST SAMPLE';
  if (priceChange === 0 && oiChange === 0) return 'NO CHANGE';
  if (oiChange === 0) return 'PRICE MOVED - OI FLAT';
  if (priceChange === 0) return 'OI CHANGED - PRICE FLAT';
  if (oiChange > 0) return priceChange > 0 ? 'LONG BUILDUP' : 'SHORT BUILDUP';
  return priceChange > 0 ? 'SHORT COVERING' : 'LONG UNWINDING';
}

function networkIdentity() {
  let local = '127.0.0.1', mac = '00:00:00:00:00:00';
  for (const rows of Object.values(os.networkInterfaces())) for (const row of rows || []) {
    if (!row.internal && row.family === 'IPv4') { local = row.address; mac = row.mac || mac; break; }
  }
  return { local, mac };
}

async function publicIp() {
  const response = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("Unable to determine this computer's public IP for SmartAPI login.");
  const ip = (await response.text()).trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error('Public IP lookup returned an invalid address.');
  return ip;
}

async function getJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  let body;
  try { body = await response.json(); } catch { throw new Error(`Angel One returned an unreadable response (HTTP ${response.status}).`); }
  if (!response.ok || body.status !== true) throw new Error(body.message || body.errorMessage || `Angel One request failed (HTTP ${response.status}).`);
  return body;
}

function resolveIndexTokens(rows) {
  const indexRows = rows.filter(r => String(r.exch_seg).toUpperCase() === 'NSE' && String(r.instrumenttype).toUpperCase() === 'AMXIDX');
    return INDEXES.map(index => {
    const row = indexRows.find(r => index.match.some(name => String(r.name || '').trim().toUpperCase() === name || String(r.symbol || '').trim().toUpperCase() === name));
    if (!row) throw new Error(`Angel One instrument master did not contain ${index.name}.`);
    return { name: index.name, token: String(row.token), exchangeType: index.exchangeType };
  });
}

class AngelMarketFeed {
  constructor(onTick, onStatus, onOptionChain) {
    this.onTick = onTick;
    this.onStatus = onStatus;
    this.onOptionChain = onOptionChain;
    this.credentials = null;
    this.socket = null;
    this.heartbeat = null;
    this.reconnect = null;
    this.stopped = true;
    this.lastTickAt = null;
    this.lastError = null;
    this.contracts = [];
    this.accessToken = '';
    this.feedToken = '';
    this.clientPublicIp = '';
    this.instruments = [];
    this.optionPoll = null;
    this.lastOptionOi = new Map();
    this.lastOptionLtp = new Map();
  }

  configured() {
    return this.credentials ? ['clientId', 'apiKey', 'password', 'totpSecret'].every(key => Boolean(this.credentials[key])) : ['ANGEL_CLIENT_ID', 'ANGEL_API_KEY', 'ANGEL_PASSWORD', 'ANGEL_TOTP_SECRET'].every(key => Boolean(process.env[key]));
  }

  setCredentials(credentials) {
    this.disconnect();
    this.credentials = credentials;
    this.lastError = null;
  }

  value(key) {
    if (this.credentials) return this.credentials[key];
    const names = { clientId: 'ANGEL_CLIENT_ID', apiKey: 'ANGEL_API_KEY', password: 'ANGEL_PASSWORD', totpSecret: 'ANGEL_TOTP_SECRET' };
    return process.env[names[key]];
  }

  status() {
    if (!this.configured()) return { state: 'NOT_CONFIGURED', detail: "Add Angel One SmartAPI credentials once in the hosting provider's protected environment variables." };
    if (this.lastError) return { state: 'ERROR', detail: this.lastError, lastTickAt: this.lastTickAt };
    if (this.stopped && !this.socket) return { state: 'DISCONNECTED', detail: 'Read-only provider is not connected.' };
    if (this.lastTickAt && Date.now() - Date.parse(this.lastTickAt) > 45000) return { state: 'STALE', detail: 'No Angel One index tick received in the last 45 seconds.', lastTickAt: this.lastTickAt };
    if (this.socket?.readyState === WebSocket.OPEN && this.lastTickAt) return { state: 'LIVE', detail: 'Angel One WebSocket connected - index ticks received.', lastTickAt: this.lastTickAt };
    if (this.socket?.readyState === WebSocket.OPEN) return { state: 'CONNECTING', detail: 'Socket open - waiting for first market tick.' };
    return { state: 'CONNECTING', detail: 'Authenticating and resolving index instruments.' };
  }

  async login() {
    const identity = networkIdentity();
    const ip = await publicIp();
    this.clientPublicIp = ip;
    const result = await getJson(`${API_ROOT}/rest/auth/angelbroking/user/v1/loginByPassword`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json',
        'X-UserType': 'USER', 'X-SourceID': 'WEB', 'X-PrivateKey': this.value('apiKey'),
        'X-ClientLocalIP': identity.local, 'X-ClientPublicIP': ip, 'X-MACAddress': identity.mac,
      },
      body: JSON.stringify({ clientcode: this.value('clientId'), password: this.value('password'), totp: makeTotp(this.value('totpSecret')) }),
    });
    this.accessToken = result.data?.jwtToken;
    this.feedToken = result.data?.feedToken;
    if (!this.accessToken || !this.feedToken) throw new Error('Angel One login succeeded without the expected feed tokens.');
  }

  async connect() {
    if (!this.configured()) throw new Error('Angel One credentials are not configured. Add the four SmartAPI values in Railway Variables; the service will connect automatically after it restarts.');
    this.disconnect();
    this.stopped = false;
    this.lastError = null;
    this.onStatus(this.status());
    try {
      await this.login();
      const masterResponse = await fetch(SCRIP_MASTER, { signal: AbortSignal.timeout(20000) });
      if (!masterResponse.ok) throw new Error("Could not download Angel One's instrument master.");
      this.instruments = await masterResponse.json();
      this.contracts = resolveIndexTokens(this.instruments);
      await this.seedIndexCloses();
      await this.fetchOptionChain();
      await this.openSocket();
      this.optionPoll = setInterval(() => this.fetchOptionChain().catch(error => this.onStatus({ ...this.status(), optionDetail: error.message })), 10000);
    } catch (error) {
      this.stopped = true;
      this.lastError = error.message;
      this.onStatus({ state: 'ERROR', detail: error.message });
      throw error;
    }
  }

  async seedIndexCloses() {
    const identity = networkIdentity();
    const result = await getJson(`${API_ROOT}/rest/secure/angelbroking/market/v1/quote/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json',
        'X-UserType': 'USER', 'X-SourceID': 'WEB', 'X-PrivateKey': this.value('apiKey'),
        Authorization: `Bearer ${this.accessToken}`,
        'X-ClientLocalIP': identity.local, 'X-ClientPublicIP': this.clientPublicIp, 'X-MACAddress': identity.mac,
      },
      body: JSON.stringify({ mode: 'OHLC', exchangeTokens: { NSE: this.contracts.map(c => c.token) } }),
    });
    for (const quote of result.data?.fetched || []) {
      const contract = this.contracts.find(c => c.token === String(quote.symbolToken));
      if (contract) contract.close = Number(quote.close) || 0;
    }
  }

  async fetchOptionChain() {
    if (nseDerivativesSession().phase !== 'SESSION') return;
    const spot = this.contracts.find(c => c.name === 'NIFTY 50')?.price;
    const indexSpot = spot || 0;
    if (!indexSpot) return;
    const expiryKey = row => {
      const value = String(row.expiry || '').toUpperCase();
      const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (iso) return `${iso[3]}${['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][Number(iso[2])-1]}${iso[1]}`;
      return value;
    };
    const expiries = [...new Set(this.instruments.filter(r => r.exch_seg === 'NFO' && r.instrumenttype === 'OPTIDX' && r.name === 'NIFTY').map(expiryKey))]
      .filter(x => /^\d{2}[A-Z]{3}\d{4}$/.test(x)).sort((a,b) => {
        const date = x => Date.UTC(Number(x.slice(5)), ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'].indexOf(x.slice(2,5)), Number(x.slice(0,2)));
        return date(a)-date(b);
      });
    const today = new Date(); today.setUTCHours(0,0,0,0);
    const expiry = expiries.find(x => {
      const month = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'].indexOf(x.slice(2,5));
      return Date.UTC(Number(x.slice(5)), month, Number(x.slice(0,2))) >= today.getTime();
    });
    if (!expiry) throw new Error('Angel One instrument master has no current NIFTY index-option expiry.');
    const atm = Math.round(indexSpot / 50) * 50;
    const expiryMonth = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'].indexOf(expiry.slice(2,5))+1;
    const expiryIso = `${expiry.slice(5)}-${String(expiryMonth).padStart(2,'0')}-${expiry.slice(0,2)}`;
    const wanted = new Set(Array.from({length: 11}, (_,i) => atm + (i-5)*50));
    const contracts = this.instruments.filter(r => r.exch_seg === 'NFO' && r.instrumenttype === 'OPTIDX' && r.name === 'NIFTY' && expiryKey(r) === expiry && wanted.has(Math.round(Number(r.strike)/100)) && ['CE','PE'].includes(r.symbol.slice(-2)));
    if (!contracts.length) throw new Error(`No NIFTY option contracts found for ${expiry}.`);
    const ids = contracts.map(r => String(r.token));
    const identity = networkIdentity();
    const result = await getJson(`${API_ROOT}/rest/secure/angelbroking/market/v1/quote/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json',
        'X-UserType': 'USER', 'X-SourceID': 'WEB', 'X-PrivateKey': this.value('apiKey'),
        Authorization: `Bearer ${this.accessToken}`,
        'X-ClientLocalIP': identity.local, 'X-ClientPublicIP': this.clientPublicIp, 'X-MACAddress': identity.mac,
      },
      body: JSON.stringify({ mode: 'FULL', exchangeTokens: { NFO: ids } }),
    });
    const fetched = result.data?.fetched || [];
    const quotes = new Map(fetched.map(q => [String(q.symbolToken), q]));
    const rows = [...wanted].sort((a,b)=>a-b).map(strike => {
      const leg = type => {
        const contract = contracts.find(r => Math.round(Number(r.strike)/100) === strike && r.symbol.endsWith(type));
        const q = contract && quotes.get(String(contract.token));
        if (!q) return { oi: 0, change: null, ltp: null, premiumChange: null, volume: 0, read: 'QUOTE MISSING' };
        const oi = Number(q.opnInterest) || 0;
        const previous = this.lastOptionOi.get(String(contract.token));
        const ltp = Number(q.ltp) || null;
        const previousLtp = this.lastOptionLtp.get(String(contract.token));
        this.lastOptionOi.set(String(contract.token), oi);
        if (ltp != null) this.lastOptionLtp.set(String(contract.token), ltp);
        const change = previous == null ? null : oi-previous;
        const premiumChange = previousLtp == null || ltp == null ? null : +(ltp-previousLtp).toFixed(2);
        const read = classifyPriceOi(premiumChange, change);
        return { oi, change, ltp, premiumChange, volume: Number(q.tradeVolume) || 0, read };
      };
      return { strike, ce: leg('CE'), pe: leg('PE') };
    });
    const totalCe = rows.reduce((s,r)=>s+r.ce.oi,0), totalPe = rows.reduce((s,r)=>s+r.pe.oi,0);
    const timestamp = new Date().toISOString();
    const previousPcr = this.previousPcr;
    const pcr = totalCe ? +(totalPe/totalCe).toFixed(2) : null;
    this.previousPcr = pcr;
    this.onOptionChain({ expiry:expiryIso, atm, pcr, pcrChange: previousPcr == null || pcr == null ? null : +(pcr-previousPcr).toFixed(2), totalCe, totalPe, quality: fetched.length === ids.length ? 'LIVE SNAPSHOT' : 'PARTIAL SNAPSHOT', source: 'Angel One SmartAPI FULL quote', capturedAt: timestamp, oi: rows.map(r => ({ strike:r.strike, ce:r.ce.oi, ceChg:r.ce.change, ceLtp:r.ce.ltp, cePriceChg:r.ce.premiumChange, ceVolume:r.ce.volume, ceRead:r.ce.read, pe:r.pe.oi, peChg:r.pe.change, peLtp:r.pe.ltp, pePriceChg:r.pe.premiumChange, peVolume:r.pe.volume, peRead:r.pe.read })) });
  }

  openSocket() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket('wss://smartapisocket.angelone.in/smart-stream', {
        headers: {
          'x-client-code': this.value('clientId'),
          Authorization: this.accessToken,
          'x-api-key': this.value('apiKey'),
          'x-feed-token': this.feedToken,
        },
        handshakeTimeout: 10000,
        maxPayload: 1024 * 1024,
      });
      this.socket = socket;
      let settled = false;
      socket.on('open', () => {
        socket.send(JSON.stringify({ action: 1, params: { mode: 1, tokenList: [{ exchangeType: 1, tokens: this.contracts.map(c => c.token) }] } }));
        this.heartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send('ping'); }, 30000);
        this.onStatus(this.status());
        settled = true;
        resolve();
      });
      socket.on('message', data => {
        if (typeof data === 'string' || Buffer.isBuffer(data) && data.toString('utf8', 0, Math.min(4, data.length)) === 'pong') return;
        const packet = Buffer.from(data);
        if (packet.length < 51 || packet[0] !== 1) return;
        const token = packet.subarray(2, 27).toString('ascii').replace(/\0/g, '');
        const contract = this.contracts.find(c => c.token === token);
        if (!contract) return;
        const price = packet.readInt32LE(43) / 100;
        const close = contract.close || 0;
        if (!Number.isFinite(price) || price <= 0) return;
        contract.price = price;
        const timestampMs = Number(packet.readBigInt64LE(35));
        const timestamp = new Date(timestampMs > 1e12 ? timestampMs : timestampMs * 1000).toISOString();
        this.lastTickAt = timestamp;
        this.onTick({ ...contract, price, close, change: close ? ((price - close) / close) * 100 : 0, timestamp });
        this.onStatus(this.status());
      });
      socket.on('error', error => {
        this.lastError = `WebSocket error: ${error.message}`;
        if (!settled) { settled = true; reject(new Error(`Angel One WebSocket failed: ${error.message}`)); }
        this.onStatus({ state: 'ERROR', detail: `WebSocket error: ${error.message}` });
      });
      socket.on('close', (code, reason) => {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
        this.lastError = `Angel One feed closed (${code}). ${String(reason || '')}`.trim();
        this.onStatus(this.status());
        if (!this.stopped) this.reconnect = setTimeout(() => this.connect().catch(() => {}), 15000);
      });
    });
  }

  disconnect() {
    this.stopped = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.reconnect);
    clearInterval(this.optionPoll);
    this.heartbeat = this.reconnect = this.optionPoll = null;
    if (this.socket) { const socket = this.socket; this.socket = null; socket.removeAllListeners(); if (socket.readyState < WebSocket.CLOSING) socket.close(); }
  }
}

module.exports = { AngelMarketFeed, makeTotp, classifyPriceOi, nseDerivativesSession };

