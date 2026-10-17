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
    // OI spurts are intraday-session data. They age like a price read and, outside the session,
    // last session's build-up is a settled prior rather than current flow.
    freshMinutes: 15,
    maxAgeMinutes: 60,
    staleConfidenceFloor: 0.2,
    closedSessionConfidence: 0.2,
  },
  news: {
    fullConfidenceAt: 5, // headlines on one entity needed for full confidence
    criticalConfidenceFactor: 0.5, // a critical event makes direction genuinely less certain
    // Headlines age from their own publication time, not from when we captured them: an
    // announcement made overnight is still news in the morning, so there is no session cap here.
    // The fade window matches the 48h aggregation window, so news is fully decayed exactly when
    // it drops out of the aggregate.
    freshMinutes: 120,
    maxAgeMinutes: 2880,
    staleConfidenceFloor: 0.25,
  },
  price: {
    momentumSpan: 0.01, // a 1% move from previous close saturates the momentum component
    momentumWeight: 0.6,
    rangeWeight: 0.4,
    // Quote ageing. The score always reflects the last known price, but its confidence is cut
    // when that price is old, and again when the exchange is shut: outside a session the last
    // close is a settled fact, not current momentum. `freshMinutes` is set to the delay the
    // Yahoo fallback is known to carry, so a normal delayed read is not punished, while a feed
    // that has genuinely stalled decays toward `staleConfidenceFloor` by `maxAgeMinutes`.
    freshMinutes: 15,
    maxAgeMinutes: 60,
    staleConfidenceFloor: 0.2,
    closedSessionConfidence: 0.2,
  },
  // Verdicts are only written when they say something new, so 24/7 operation does not write an
  // identical row every minute. History stays complete enough to forward-fill for backtesting.
  // A confidence move counts as new: aging evidence lowers conviction without moving the score,
  // and a stale row would otherwise let a call stand downstream after the confidence had gone.
  materialChange: {
    scoreDelta: 0.05,
    confidenceDelta: 0.05,
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

function newsSignal(entity, config, options = {}) {
  if (!entity) return unavailable('news', 'no scored news on this entity');
  const pressure = num(entity.pressure);
  if (pressure === null) return unavailable('news', 'no pressure value');

  const itemCount = num(entity.itemCount) || 0;
  const severity = String(entity.maxSeverity || 'LOW').toUpperCase();
  const base = clamp(itemCount / config.news.fullConfidenceAt, 0, 1)
    * (severity === 'CRITICAL' ? config.news.criticalConfidenceFactor : 1);

  // News ages from the newest headline on the entity, never from when we captured it: an
  // announcement made after the close is still news in the morning. Unlike a price or an
  // option-flow reading, a headline does not stop being news because the exchange is shut, so
  // there is deliberately no session cap here.
  const ageMinutes = ageMinutesSince(entity.latestAt || options.asOf || null, options.now);
  const freshness = freshnessFactor(ageMinutes, config.news);
  const confidence = clamp(base * freshness, 0, 1);

  return {
    key: 'news',
    available: true,
    score: clamp(pressure, -1, 1),
    confidence,
    detail: `${itemCount} item(s), severity ${severity}, net sentiment ${num(entity.netSentiment) ?? 0}, `
      + `pressure ${round(clamp(pressure, -1, 1), 3)}`
      + (ageMinutes !== null
        ? ` [newest ${Math.round(ageMinutes / 60)}h old${freshness < 1 ? `, aged to ${round(freshness, 2)}` : ''}]`
        : ''),
  };
}

function flowSignal(flow, config, options = {}) {
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

  // OI spurts are intraday-session data: they age like a price read, and outside the session the
  // last session's build-up is a settled prior, not current flow.
  const ageMinutes = ageMinutesSince(options.asOf || null, options.now);
  const freshness = freshnessFactor(ageMinutes, config.flow);
  const marketClosed = options.marketOpen === false;
  const closedFactor = marketClosed ? clamp(num(config.flow.closedSessionConfidence) ?? 1, 0, 1) : 1;
  const confidence = clamp(coverage * bothLegs * freshness * closedFactor, 0, 1);

  const notes = [];
  if (ageMinutes !== null) notes.push(`flow ${Math.round(ageMinutes)}m old`);
  if (marketClosed) notes.push('market closed: last session flow is not live');
  else if (freshness < 1) notes.push(`aged to ${round(freshness, 2)}`);

  return {
    key: 'flow',
    available: true,
    score,
    confidence,
    detail: `mix LB${longBuildup}/SB${shortBuildup}/SC${shortCovering}/LU${longUnwinding}, put-call OI ratio ${pcrText}`
      + (notes.length ? ` [${notes.join('; ')}]` : ''),
  };
}

// Minutes between a timestamp and `now`, or null when either is missing or unparseable. Accepts a
// Date, an ISO string or an epoch number, so any feature can be dated by its exchange time, its
// own publication time, or the moment the worker captured it.
function ageMinutesSince(raw, now) {
  if (!now || !raw) return null;
  const at = raw instanceof Date ? raw.getTime() : Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, (new Date(now).getTime() - at) / 60000);
}

// The exchange timestamp of a quote, or the moment we captured it, as minutes of age. Yahoo
// carries `quoteTime` (the exchange's own time); rows that do not (e.g. Angel today) fall back to
// the feature `as_of` the worker passes in. Null when nothing can be dated, in which case age is
// simply not penalised - only the session check applies.
function quoteAgeMinutes(quote, options = {}) {
  return ageMinutesSince((quote && quote.quoteTime) || options.asOf || null, options.now);
}

// 1 while the evidence is fresh, then a straight line down to the floor at maxAgeMinutes. An
// unknown age scores 1: we do not invent staleness we cannot measure. `window` is any component's
// age window (freshMinutes / maxAgeMinutes / staleConfidenceFloor).
function freshnessFactor(ageMinutes, window) {
  if (ageMinutes === null) return 1;
  const fresh = num(window.freshMinutes) ?? 0;
  const max = num(window.maxAgeMinutes) ?? fresh;
  const floor = clamp(num(window.staleConfidenceFloor) ?? 0, 0, 1);
  if (ageMinutes <= fresh || max <= fresh) return 1;
  if (ageMinutes >= max) return floor;
  const decayed = 1 - (ageMinutes - fresh) / (max - fresh);
  return clamp(decayed, floor, 1);
}

function priceSignal(quote, config, options = {}) {
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

  // Age the read. The direction of the last close is still information, so the score is kept; it
  // is the confidence that carries the "this is not a live tick" warning, and confidence is what
  // the direction threshold turns on. Outside a session every read is a settled prior, so it is
  // capped at `closedSessionConfidence` regardless of when we captured it.
  const ageMinutes = quoteAgeMinutes(quote, options);
  const freshness = freshnessFactor(ageMinutes, config.price);
  const marketClosed = options.marketOpen === false;
  const closedFactor = marketClosed ? clamp(num(config.price.closedSessionConfidence) ?? 1, 0, 1) : 1;
  const baseConfidence = range === null ? 0.7 : 1;
  const confidence = clamp(baseConfidence * freshness * closedFactor, 0, 1);

  const notes = [];
  if (ageMinutes !== null) notes.push(`quote ${Math.round(ageMinutes)}m old`);
  if (marketClosed) notes.push('market closed: last close is not live');
  else if (freshness < 1) notes.push(`aged to ${round(freshness, 2)}`);

  return {
    key: 'price',
    available: true,
    score,
    confidence,
    detail: `ltp ${ltp} vs prev close ${close} (${round(movePct * 100, 2)}%)`
      + (range === null ? '' : `, range position ${round(range, 3)}`)
      + (notes.length ? ` [${notes.join('; ')}]` : ''),
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

// Builds one verdict per horizon for a symbol from the feature maps the worker loaded. `now` and
// `marketOpen` are the session context the worker resolved; the `*AsOf` values date component
// rows that carry no timestamp of their own (quotes and flow; news is dated by its own newest
// headline).
function verdictsForSymbol({ symbol, features, config, now, marketOpen, quoteAsOf, flowAsOf, newsAsOf }) {
  const news = features.news ? features.news.get(symbol) : null;
  const flow = features.flow ? features.flow.get(symbol) : null;
  const quote = features.quote ? features.quote.get(symbol) : null;

  return HORIZONS.map((horizon) => combineVerdict({
    symbol,
    horizon,
    signals: {
      news: newsSignal(news, config, { now, asOf: newsAsOf }),
      flow: flowSignal(flow, config, { now, asOf: flowAsOf, marketOpen }),
      price: priceSignal(quote, config, { now, marketOpen, asOf: quoteAsOf }),
    },
    config,
  }));
}

// True when a verdict says something the stored one does not. Keeps the table meaningful
// instead of writing an identical row on every tick.
function isMaterialChange(previous, verdict, { scoreDelta, confidenceDelta, maxStaleMinutes }, now = Date.now()) {
  if (!previous) return true;
  if (previous.direction !== verdict.direction) return true;
  const priorScore = num(previous.score);
  if (priorScore === null) return true;
  if (Math.abs(priorScore - verdict.score) >= scoreDelta) return true;
  const priorConfidence = num(previous.confidence);
  const confidenceStep = num(confidenceDelta) ?? scoreDelta;
  if (priorConfidence !== null && Math.abs(priorConfidence - verdict.confidence) >= confidenceStep) return true;
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
  ageMinutesSince,
  quoteAgeMinutes,
  freshnessFactor,
  combineVerdict,
  verdictsForSymbol,
  isMaterialChange,
};
