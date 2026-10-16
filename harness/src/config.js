'use strict';

// Central configuration for the harness. Loads .env (repo root) without adding a
// dependency, then exposes typed values with safe defaults.

const fsSync = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function loadEnvFile(file) {
  try {
    const raw = fsSync.readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let value = m[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[m[1]] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

loadEnvFile(path.join(ROOT, '.env'));

const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
};
const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const int = (value, fallback) => Math.trunc(num(value, fallback));
const list = (value, fallback = []) =>
  (value === undefined || value === '' ? fallback : String(value).split(','))
    .map((s) => s.trim())
    .filter(Boolean);

const DEFAULT_FEEDS = [
  'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
  'https://www.business-standard.com/rss/markets-106.rss',
  'https://www.moneycontrol.com/rss/marketreports.xml',
  'https://news.google.com/rss/search?q=indian+stock+market&hl=en-IN&gl=IN&ceid=IN:en',
];

const ANGEL_API_ROOT = 'https://apiconnect.angelone.in';

function sslFor(url) {
  if (!url) return false;
  if (bool(process.env.DATABASE_SSL, false)) return 'require';
  if (/@(localhost|127\.0\.0\.1|db)[:/]/.test(url)) return false;
  return 'require';
}

const config = {
  root: ROOT,
  env: process.env.NODE_ENV || 'development',
  dryRun: bool(process.env.HARNESS_DRY_RUN, false),
  once: bool(process.env.HARNESS_ONCE, false),
  role: process.env.HARNESS_ROLE || 'all', // all | w0 | w1 | w2 | w3 | w4 | w5 | w6 | w8
  workerName: process.env.HARNESS_WORKER_NAME || `harness-${process.pid}`,

  database: {
    url: process.env.DATABASE_URL || '',
    ssl: sslFor(process.env.DATABASE_URL || ''),
    max: int(process.env.HARNESS_DB_POOL, 5),
  },

  angel: {
    apiRoot: ANGEL_API_ROOT,
    scripMasterUrl: 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json',
    clientId: process.env.ANGEL_CLIENT_ID || '',
    apiKey: process.env.ANGEL_API_KEY || '',
    password: process.env.ANGEL_PASSWORD || '',
    totpSecret: process.env.ANGEL_TOTP_SECRET || '',
    timeoutMs: int(process.env.ANGEL_TIMEOUT_MS, 15000),
    maxPerSecond: num(process.env.ANGEL_MAX_PER_SECOND, 2),
  },

  nse: {
    enabled: bool(process.env.HARNESS_NSE_ENABLED, true),
    baseUrl: 'https://www.nseindia.com',
    timeoutMs: int(process.env.HARNESS_NSE_TIMEOUT_MS, 15000),
    minIntervalMs: int(process.env.HARNESS_NSE_MIN_INTERVAL_MS, 1200),
    oiSpurtsPaths: {
      underlyings: ['/api/live-analysis-oi-spurts-underlyings'],
      contracts: ['/api/live-analysis-oi-spurts-contracts'],
    },
    optionChainPaths: {
      index: '/api/option-chain-indices?symbol=',
      equity: '/api/option-chain-equities?symbol=',
    },
  },

  rss: {
    feeds: list(process.env.HARNESS_RSS_FEEDS, DEFAULT_FEEDS),
    timeoutMs: int(process.env.HARNESS_RSS_TIMEOUT_MS, 15000),
    maxItemsPerFeed: int(process.env.HARNESS_RSS_MAX_ITEMS, 40),
  },

  poll: {
    marketMs: int(process.env.HARNESS_MARKET_INTERVAL_MS, 10000),
    flowMs: int(process.env.HARNESS_FLOW_INTERVAL_MS, 60000),
    newsMs: int(process.env.HARNESS_NEWS_INTERVAL_MS, 300000),
    scoreMs: int(process.env.HARNESS_SCORE_INTERVAL_MS, 15000),
    heartbeatMs: int(process.env.HARNESS_HEARTBEAT_INTERVAL_MS, 30000),
  },

  universe: {
    indices: list(process.env.HARNESS_INDEX_UNIVERSE, ['NIFTY 50', 'BANK NIFTY', 'MIDCAP NIFTY']),
    equities: list(process.env.HARNESS_EQUITY_UNIVERSE, ['RELIANCE', 'TCS', 'HDFCBANK']),
  },

  retentionDays: int(process.env.HARNESS_RETENTION_DAYS, 90),
  tunnableRetentionFloor: 90,

  // Slice 5. Delivery is shadow-first: only PUBLISH_MODE=live actually calls Telegram, so the
  // publish path can be exercised end to end before a real alert is ever sent.
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    apiRoot: process.env.TELEGRAM_API_ROOT || 'https://api.telegram.org',
    timeoutMs: int(process.env.TELEGRAM_TIMEOUT_MS, 10000),
  },

  publish: {
    mode: (process.env.PUBLISH_MODE || 'shadow').trim().toLowerCase(), // shadow | live
  },

  llm: {
    enabled: bool(process.env.HARNESS_LLM_ENABLED, false),
    openRouterKey: process.env.OPENROUTER_API_KEY || '',
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct:free',
  },
};

config.angel.configured = () =>
  Boolean(config.angel.clientId && config.angel.apiKey && config.angel.password && config.angel.totpSecret);

config.telegram.configured = () => Boolean(config.telegram.botToken && config.telegram.chatId);

module.exports = config;
