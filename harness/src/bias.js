'use strict';

// Slice 3 - the bias meter. Pure functions only: given the Slice 2 features and a price
// snapshot, produce a directional verdict per symbol and horizon. It never touches the network,
// the database or a model, so a verdict can always be reproduced from stored inputs.
//
// Two rules shape the whole design:
//   1. Weights and thresholds are data, not code. They live in `config_registry`, versioned and
//      human-approved, so tuning the meter is a reviewable change rather than a deploy.
//   2. Every signal votes with a score AND a confidence. When price or flow is missing the
//      verdict loses confidence instead of silently drifting to a number nobody can explain.

const { ENTITY_ALIASES } = require('./lexicon');

const HORIZONS = ['INTRADAY', 'SWING', 'POSITIONAL'];
const ENGINE_VERSION = 'bias-engine-1';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const round = (value, digits = 4) => (Number.isFinite(value) ? +value.toFixed(digits) : null);

// The baseline configuration. The bias worker registers it in `config_registry` on first run,
// so whatever weights are actually running are always inspectable and supersedeable.
const DEFAULT_BIAS_CONFIG = {
  version: 'bias-v1',
  thresholds: {
    direction: 0.15, // |score| needed to call BULLISH/BEARISH rather than NEUTRAL
    minConfidence: 0.2, // below this we refuse to call a direction at all
  },
  // How much each evidence source is trusted per horizon. Intraday leans on flow and price;
  // positional leans on news and trend.
  weights: {
    INTRADAY: { flow: 0.5, price: 0.4, news: 0.1 },
    SWING: { flow: 0.3, price: 0.4, news: 0.3 },
    POSITIONAL: { flow: 0.15, price: 0.45, news: 0.4 },
  },
  flow: {
    quadrantWeight: 0.75, // classic price+OI build-up table
    pcrWeight: 0.25, // put-call open-interest change
    pcrNeutral: 1.0,
    pcrSpan: 1.0,
    fullConfidenceAt: 10, // option contracts needed for full confidence
  },
  news: {
    fullConfidenceAt: 5, // headlines on one entity needed for full confidence
    criticalConfidenceFactor: 0.5, // a critical event makes direction genuinely less certain
  },
  price: {
    momentumSpan: 0.01, // a 1% move from previous close saturates the momentum component
    momentumWeight: 0.6,
    rangeWeight: 0.4,
  },
  // Verdicts are only written when they say something new, so 24/7 operation does not write an
  // identical row every minute. History stays complete enough to forward-fill for backtesting.
  materialChange: {
    scoreDelta: 0.05,
    maxStaleMinutes: 15,
  },
};

function resolveConfig(candidate) {
  const stored = candidate && typeof candidate === 'object' ? candidate : {};
  const merged = { ...DEFAULT_BIAS_CONFIG, ...stored };
  for (const section of ['thresholds', 'weights', 'flow', 'news', 'price', 'materialChange']) {
    merged[section] = { ...DEFAULT_BIAS_CONFIG[section], ...(stored[section] || {}) };
  }
  if (!merged.version) merged.version = DEFAULT_BIAS_CONFIG.version;
  return merged;
}

// ---------------------------------------------------------------------------
// Universe
// ---------------------------------------------------------------------------
// The broker universe is written the way a human says it; the feeds use NSE symbols.
const INDEX_SYMBOL_ALIASES = {
  'NIFTY 50': 'NIFTY',
  NIFTY50: 'NIFTY',
  'BANK NIFTY': 'BANKNIFTY',
  BANKNIFTY: 'BANKNIFTY',
  'MIDCAP NIFTY': 'MIDCPNIFTY',
  MIDCAPNIFTY: 'MIDCPNIFTY',
  'NIFTY MIDCAP': 'MIDCPNIFTY',
  FINNIFTY: 'FINNIFTY',
  'FIN NIFTY': 'FINNIFTY',
};

function normalizeUniverseSymbol(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return null;
  return INDEX_SYMBOL_ALIASES[raw] || raw.replace(/\s+/g, '');
}

// Only symbols the lexicon recognises are tradeable names; market-wide labels such as MARKET,
// SENSEX or RUPEE are dropped so the meter never tries to price a concept.
function tradeableSymbols(config = {}) {
  const universe = config.universe || {};
  const set = new Set(Object.keys(ENTITY_ALIASES));
  for (const value of [...(universe.indices || []), ...(universe.equities || [])]) {
    const symbol = normalizeUniverseSymbol(value);
    if (symbol) set.add(symbol);
  }
  return set;
}

function trackedSymbols({ config = {}, newsEntities = [] } = {}) {
  const universe = config.universe || {};
  const tradeable = tradeableSymbols(config);
  const set = new Set();

  for (const value of [...(universe.indices || []), ...(universe.equities || [])]) {
    const symbol = normalizeUniverseSymbol(value);
    if (symbol) set.add(symbol);
  }
  for (const entity of newsEntities) {
    const symbol = normalizeUniverseSymbol(entity && entity.symbol);
    if (symbol && tradeable.has(symbol)) set.add(symbol);
  }
  return [...set].sort();
}

// ---------------------------------------------------------------------------
// Individual signals. Each returns { key, available, score, confidence, detail }.
// ---------------------------------------------------------------------------
function unavailable(key, detail) {
  return { key, available: false, score: 0, confidence: 0, detail };
}

function newsSignal(entity, config) {
  if (!entity) return unavailable('news', 'no scored news on this entity');
  const pressure = num(entity.pressure);
  if (pressure === null) return unavailable('news', 'no pressure value');

  const itemCount = num(entity.itemCount) || 0;
  const severity = String(entity.maxSeverity || 'LOW').toUpperCase();
  const confidence = clamp(itemCount / config.news.fullConfidenceAt, 0, 1)
    * (severity === 'CRITICAL' ? config.news.criticalConfidenceFactor : 1);

  return {
    key: 'news',
    available: true,
    score: clamp(pressure, -1, 1),
    confidence: clamp(confidence, 0, 1),
    detail: `${itemCount} item(s), severity ${severity}, net sentiment ${num(entity.netSentiment) ?? 0}, pressure ${round(clamp(pressure, -1, 1), 3)}`,
  };
}

function flowSignal(flow, config) {
  if (!flow) return unavailable('flow', 'no OI-spurt flow for this symbol');

  const longBuildup = num(flow.longBuildup) || 0;
  const shortBuildup = num(flow.shortBuildup) || 0;
  const shortCovering = num(flow.shortCovering) || 0;
  const longUnwinding = num(flow.longUnwinding) || 0;
  const total = longBuildup + shortBuildup + shortCovering + longUnwinding;
  if (!total) return unavailable('flow', 'no classified option contracts');

  // The standard price + open-interest table: new longs are bullish, new shorts bearish,
  // covering is a weaker bullish, unwinding a weaker bearish.
  const quadrant = (
    longBuildup * 1
    + shortCovering * 0.5
    - shortBuildup * 1
    - longUnwinding * 0.5
  ) / total;

  // Put-call open-interest change: writes on the put side read as support being built.
  const ce = num(flow.ceOiChange);
  const pe = num(flow.peOiChange);
  let pcrScore = null;
  let pcrText = 'n/a';
  if (ce !== null && pe !== null) {
    if (ce === 0 && pe === 0) {
      pcrScore = 0;
      pcrText = 'flat';
    } else if (ce === 0) {
      pcrScore = pe > 0 ? 1 : -1; // only the put leg moved
      pcrText = 'put leg only';
    } else {
      const ratio = pe / ce;
      pcrScore = clamp((ratio - config.flow.pcrNeutral) / config.flow.pcrSpan, -1, 1);
      pcrText = String(round(ratio, 3));
    }
  }

  const wQuadrant = config.flow.quadrantWeight;
  const wPcr = pcrScore === null ? 0 : config.flow.pcrWeight;
  const denom = wQuadrant + wPcr;
  const score = denom > 0 ? clamp((quadrant * wQuadrant + (pcrScore ?? 0) * wPcr) / denom, -1, 1) : 0;

  const optionCount = num(flow.optionCount) || 0;
  const coverage = clamp(optionCount / config.flow.fullConfidenceAt, 0, 1);
  const bothLegs = ce !== null && pe !== null ? 1 : 0.6;

  return {
    key: 'flow',
    available: true,
    score,
    confidence: clamp(coverage * bothLegs, 0, 1),
    detail: `mix LB${longBuildup}/SB${shortBuildup}/SC${shortCovering}/LU${longUnwinding}, put-call OI ratio ${pcrText}`,
  };
}

function priceSignal(quote, config) {
  if (!quote) return unavailable('price', 'no quote for this symbol');
  const ltp = num(quote.ltp);
  const close = num(quote.close);
  if (ltp === null || close === null || close === 0) return unavailable('price', 'quote missing ltp or previous close');

  const movePct = (ltp - close) / close;
  const momentum = clamp(movePct / config.price.momentumSpan, -1, 1);

  const high = num(quote.high);
  const low = num(quote.low);
  let range = null;
  if (high !== null && low !== null && high > low) {
    range = clamp(((ltp - low) / (high - low)) * 2 - 1, -1, 1);
  }

  const wMomentum = config.price.momentumWeight;
  const wRange = range === null ? 0 : config.price.rangeWeight;
  const score = clamp((momentum * wMomentum + (range ?? 0) * wRange) / (wMomentum + wRange), -1, 1);

  return {
    key: 'price',
    available: true,
    score,
    confidence: range === null ? 0.7 : 1,
    detail: `ltp ${ltp} vs prev close ${close} (${round(movePct * 100, 2)}%)${range === null ? '' : `, range position ${round(range, 3)}`}`,
  };
}

// ---------------------------------------------------------------------------
// Combination
// ---------------------------------------------------------------------------
function combineVerdict({ symbol, horizon, signals, config }) {
  const weights = config.weights[horizon] || config.weights.SWING;
  const components = {};
  let weightTotal = 0;
  let weightAvailable = 0;
  let scoreSum = 0;
  let confidenceSum = 0;

  for (const key of Object.keys(weights)) {
    const weight = Number(weights[key]) || 0;
    weightTotal += weight;
    const signal = signals[key];
    if (!signal || !signal.available) {
      components[key] = {
        weight,
        available: false,
        score: null,
        confidence: 0,
        detail: signal ? signal.detail : 'not supplied',
      };
      continue;
    }
    weightAvailable += weight;
    scoreSum += signal.score * weight;
    confidenceSum += signal.confidence * weight;
    components[key] = {
      weight,
      available: true,
      score: round(signal.score),
      confidence: round(signal.confidence),
      detail: signal.detail,
    };
  }

  const coverage = weightTotal > 0 ? weightAvailable / weightTotal : 0;
  const score = weightAvailable > 0 ? clamp(scoreSum / weightAvailable, -1, 1) : 0;
  const baseConfidence = weightAvailable > 0 ? confidenceSum / weightAvailable : 0;
  // Confidence is the weighted quality of what we have, multiplied by how much of the intended
  // evidence is actually present. A positional call backed only by intraday-weighted flow is
  // therefore weak by construction.
  const confidence = clamp(baseConfidence * coverage, 0, 1);

  const { direction: directionThreshold, minConfidence } = config.thresholds;
  let direction = 'NEUTRAL';
  if (confidence >= minConfidence) {
    if (score >= directionThreshold) direction = 'BULLISH';
    else if (score <= -directionThreshold) direction = 'BEARISH';
  }

  const evidence = [];
  for (const key of Object.keys(weights)) {
    const component = components[key];
    if (component.available) {
      evidence.push(`${key}: ${component.detail} -> score ${round(component.score, 3)} at ${Math.round(component.confidence * 100)}% confidence`);
    } else {
      evidence.push(`${key}: unavailable (${component.detail})`);
    }
  }
  if (coverage < 1) {
    evidence.push(`coverage ${Math.round(coverage * 100)}% of the intended evidence weight`);
  }
  if (direction === 'NEUTRAL' && confidence < minConfidence) {
    evidence.push(`withheld: confidence ${round(confidence, 3)} below floor ${minConfidence}`);
  }

  return {
    symbol,
    horizon,
    direction,
    score: round(score),
    confidence: round(confidence),
    coverage: round(coverage),
    components,
    evidence,
    configVersion: config.version,
    engineVersion: ENGINE_VERSION,
  };
}

// Builds one verdict per horizon for a symbol from the feature maps the worker loaded.
function verdictsForSymbol({ symbol, features, config }) {
  const news = features.news ? features.news.get(symbol) : null;
  const flow = features.flow ? features.flow.get(symbol) : null;
  const quote = features.quote ? features.quote.get(symbol) : null;

  return HORIZONS.map((horizon) => combineVerdict({
    symbol,
    horizon,
    signals: {
      news: newsSignal(news, config),
      flow: flowSignal(flow, config),
      price: priceSignal(quote, config),
    },
    config,
  }));
}

// True when a verdict says something the stored one does not. Keeps the table meaningful
// instead of writing an identical row on every tick.
function isMaterialChange(previous, verdict, { scoreDelta, maxStaleMinutes }, now = Date.now()) {
  if (!previous) return true;
  if (previous.direction !== verdict.direction) return true;
  const priorScore = num(previous.score);
  if (priorScore === null) return true;
  if (Math.abs(priorScore - verdict.score) >= scoreDelta) return true;
  const priorAt = previous.as_of instanceof Date ? previous.as_of.getTime() : Date.parse(previous.as_of || '');
  if (!Number.isFinite(priorAt)) return true;
  return now - priorAt >= maxStaleMinutes * 60000;
}

module.exports = {
  HORIZONS,
  ENGINE_VERSION,
  DEFAULT_BIAS_CONFIG,
  INDEX_SYMBOL_ALIASES,
  resolveConfig,
  normalizeUniverseSymbol,
  tradeableSymbols,
  trackedSymbols,
  newsSignal,
  flowSignal,
  priceSignal,
  combineVerdict,
  verdictsForSymbol,
  isMaterialChange,
};
