'use strict';

// Slice 5 - the Telegram publisher.
//
// Two pieces: a pure message formatter, and a tiny Bot API client with no dependency (plain
// fetch). The client is shadow-first: unless PUBLISH_MODE is exactly `live`, send() composes
// nothing on the wire and reports that it was skipped. That is deliberate - the whole publish
// path should be exercised, and auditable, before a single real alert leaves the machine.
//
// Messages are plain text with no parse_mode, and every value is formatted here rather than
// interpolated raw. That keeps the output strict ASCII, so the mojibake that plagued the older
// UI cannot get in through the alert channel either.

const config = require('./config');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const num = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

function money(value) {
  const n = num(value);
  return n === null ? '-' : n.toFixed(2);
}

function ratio(value) {
  const n = num(value);
  return n === null ? '-' : n.toFixed(2);
}

function percent(value) {
  const n = num(value);
  return n === null ? '-' : `${(n * 100).toFixed(0)}%`;
}

// IST is the trading clock. Formatting is done on an explicit offset rather than via Intl so the
// output is byte-stable regardless of the host locale.
function istDateTime(value) {
  const date = new Date(value === undefined || value === null ? Date.now() : value);
  if (Number.isNaN(date.getTime())) return '-';
  const shifted = new Date(date.getTime() + 5.5 * 3600 * 1000);
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  const month = MONTHS[shifted.getUTCMonth()];
  const year = shifted.getUTCFullYear();
  const hours = String(shifted.getUTCHours()).padStart(2, '0');
  const minutes = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${day} ${month} ${year}, ${hours}:${minutes}`;
}

function instrument(signal) {
  if (signal.instrument) return String(signal.instrument);
  if (String(signal.kind || '').toUpperCase() === 'OPTION' && signal.strike !== null && signal.strike !== undefined) {
    const parts = [signal.symbol];
    if (signal.expiry) parts.push(String(signal.expiry));
    parts.push(String(signal.strike));
    if (signal.option_type) parts.push(String(signal.option_type));
    return parts.join(' ');
  }
  return `${signal.symbol} spot / futures`;
}

// The exact text a household member receives. Deterministic: same rows in, same bytes out.
function formatSignal(signal, options = {}) {
  const mode = String(options.mode || signal.mode || 'live').toLowerCase();
  const shadow = mode !== 'live';
  const lines = [
    shadow ? 'TRADING FACTORY - SIGNAL (SHADOW)' : 'TRADING FACTORY - SIGNAL',
    `${signal.horizon} ${signal.symbol} - ${signal.direction}`,
    `Instrument: ${instrument(signal)}`,
    `Entry: ${money(signal.entry)}`,
    `Stop: ${money(signal.stop)}`,
    `Target: ${money(signal.target)}`,
    `R:R ${ratio(signal.rr)} | Confidence ${percent(signal.confidence)}`,
  ];

  if (Array.isArray(signal.reasons) && signal.reasons.length) {
    lines.push('Why:');
    for (const reason of signal.reasons.slice(0, 4)) lines.push(` - ${reason}`);
  }

  lines.push(`Config: ${signal.strategy_version || signal.strategyVersion || signal.config_version || 'n/a'}`);
  lines.push(`Decided: ${istDateTime(options.now || signal.published_at)} IST`);
  lines.push('Decision support only. Execution is always manual; this tool never places orders.');
  if (shadow) lines.push('SHADOW MODE: composed only, nothing was delivered.');
  return lines.join('\n');
}

class TelegramClient {
  constructor(options = {}) {
    this.token = options.token !== undefined ? options.token : config.telegram.botToken;
    this.chatId = options.chatId !== undefined ? options.chatId : config.telegram.chatId;
    this.apiRoot = String(options.apiRoot || config.telegram.apiRoot).replace(/\/+$/, '');
    this.mode = String(options.mode || config.publish.mode || 'shadow').toLowerCase();
    this.timeoutMs = options.timeoutMs || config.telegram.timeoutMs;
    this.fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  }

  get shadow() {
    return this.mode !== 'live';
  }

  configured() {
    return Boolean(this.token && this.chatId);
  }

  // Never throws: delivery is reported, and the caller decides whether to retry. A shadow client
  // never touches the network, whatever the configuration.
  async send(text) {
    if (this.shadow) return { delivered: false, skipped: 'shadow', mode: 'shadow' };
    if (!this.configured()) return { delivered: false, skipped: 'not-configured', mode: 'live' };
    if (typeof this.fetchImpl !== 'function') {
      return { delivered: false, skipped: 'no-fetch', mode: 'live' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.apiRoot}/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
        signal: controller.signal,
      });
      if (!response || !response.ok) {
        const body = response && typeof response.text === 'function'
          ? await response.text().catch(() => '')
          : '';
        return {
          delivered: false,
          mode: 'live',
          error: `telegram responded ${response ? response.status : 'no response'} ${String(body).slice(0, 200)}`.trim(),
        };
      }
      return { delivered: true, mode: 'live' };
    } catch (error) {
      return { delivered: false, mode: 'live', error: error.message };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { formatSignal, istDateTime, TelegramClient };
