'use strict';

// Central configuration for the harness. Loads .env (repo root) without adding a
// dependency, then exposes typed values with safe defaults.

const fsSync = require('node:fs');
const path = require('node:path');
const { normalisePublishMode, resolvePublishMode } = require('./publish-mode');

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
  role: process.env.HARNESS_ROLE || 'all', // all | w0 | w1 | w2 | w3 | w4 | w5 | w6 | w7 | w8 | w9
  workerName: process.env.HARNESS_WORKER_NAME || `harness-${process.pid}`,

  database: {
    url: process.env.DATABASE_URL || '',
    ssl: sslFor(process.env.DATABASE_URL || ''),
    max: int(process.env.HARNESS_DB_POOL, 5),
  },

  angel: {
    apiRoot: ANGEL_API_ROOT,
    scripMasterUrl: 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json',
    // The master is about 35 MB. A 15-25 second fetch is not enough on a slow link, so
    // the download gets its own longer ceiling and a local cache. The cache is public
    // instrument data, never credentials.
    scripMasterTimeoutMs: int(process.env.ANGEL_SCRIP_MASTER_TIMEOUT_MS, 120000),
    scripMasterCacheHours: int(process.env.ANGEL_SCRIP_MASTER_CACHE_HOURS, 12),
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

  // Slice 5.5. Free fallback quote source used when Angel One is not configured, so the bias
  // meter's `price` component has an input. Every row it produces is tagged `yahoo-delayed`,
  // because Yahoo's NSE quotes lag the exchange.
  yahoo: {
    enabled: bool(process.env.HARNESS_YAHOO_ENABLED, true),
    apiRoot: process.env.HARNESS_YAHOO_API_ROOT || 'https://query1.finance.yahoo.com',
    range: process.env.HARNESS_YAHOO_RANGE || '1d',
    interval: process.env.HARNESS_YAHOO_INTERVAL || '1d',
    timeoutMs: int(process.env.HARNESS_YAHOO_TIMEOUT_MS, 15000),
    spacingMs: int(process.env.HARNESS_YAHOO_SPACING_MS, 400),
    userAgent: process.env.HARNESS_YAHOO_USER_AGENT
      || 'Mozilla/5.0 (compatible; TradingFactory/0.1; market-intelligence harness)',
  },

  // Worker 7. An option plan whose premium series never arrives cannot be judged against spot.
  // Instead of parking it for the whole holding window (30 days for SWING), settle it as
  // NO_PRICE_SOURCE after this grace. The default of 8 hours means a plan published during the
  // session is settled after that session's close, while still leaving room for a delayed feed.
  evaluate: {
    unpricedGraceHours: num(process.env.HARNESS_UNPRICED_GRACE_HOURS, 8),
  },

  // Slice 10. The broker WebSocket is the only free trade-level feed: Snap Quote
  // carries five book levels for NSE cash and F&O, while Depth mode adds twenty
  // levels for NSE cash. The worker keeps a bounded set of tokens (open plans plus
  // the configured universe) so the broker's subscription quota is never exhausted.
  tape: {
    enabled: bool(process.env.HARNESS_TAPE_ENABLED, true),
    depthTokens: int(process.env.HARNESS_TAPE_DEPTH_TOKENS, 50),
    snapshotMs: int(process.env.HARNESS_TAPE_SNAPSHOT_MS, 1000),
    refreshMs: int(process.env.HARNESS_TAPE_REFRESH_MS, 60000),
    reconnectMs: int(process.env.HARNESS_TAPE_RECONNECT_MS, 5000),
    retentionDays: int(process.env.HARNESS_TAPE_RETENTION_DAYS, 7),
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
    // Global default: shadow | live. Only `live` sends; anything else is shadow.
    mode: normalisePublishMode(process.env.PUBLISH_MODE),
    // Per-horizon so publishing can be enabled one horizon at a time (PUBLISH_MODE_SWING=live, ...),
    // Intraday last. A per-horizon value wins over the global one.
    modeFor: (horizon) => resolvePublishMode(horizon),
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
