'use strict';

// Slice 2 intelligence layer. Pure functions only: no network, no DB, no LLM. Each function
// takes per-item inputs and returns cross-item features, which is what makes the whole
// pipeline unit-testable and replayable, and keeps the decision path model-free.
//
// Two rolls happen here:
//   * aggregateNewsEntities - one headline is noise, a cluster of headlines on the same name
//     is a signal. Groups scored news by entity over a rolling window.
//   * computeFlowFeatures  - turns raw NSE OI-spurt rows into per-symbol option-flow features
//     (CE/PE open-interest change, put-call ratio and build-up quadrant mix).
//
// Neither function emits a direction or a verdict; that is the bias meter's job (Slice 3).

const SEVERITY_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
// Like toNumber but keeps "missing" distinct from zero, which matters for a price: a premium
// of 0 is not the same as an unquoted contract.
const nullableNumber = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const round = (value, digits = 3) => (Number.isFinite(value) ? +value.toFixed(digits) : 0);

// Accepts a Date (postgres driver), an ISO string or an epoch number.
function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const ts = Date.parse(value || '');
  return Number.isFinite(ts) ? ts : null;
}

function severityRank(severity) {
  return SEVERITY_RANK[String(severity || '').toUpperCase()] ?? 0;
}

// NSE spells the option side out ("Put"/"Call") while signals and the rest of the pipeline use
// the market convention ("PE"/"CE"). Canonicalise here so a feed spelling change cannot
// silently zero out the put-call ratio.
const OPTION_TYPE_ALIASES = {
  CE: 'CE',
  C: 'CE',
  CALL: 'CE',
  PE: 'PE',
  P: 'PE',
  PUT: 'PE',
};

function normalizeOptionType(value) {
  return OPTION_TYPE_ALIASES[String(value || '').toUpperCase().trim()] || null;
}

// Reads either camelCase (fresh NSE payloads) or snake_case (stored rows).
function field(row, camel, snake) {
  if (row[camel] !== undefined && row[camel] !== null) return row[camel];
  if (snake && row[snake] !== undefined && row[snake] !== null) return row[snake];
  return undefined;
}

// ---------------------------------------------------------------------------
// News: entity-level pressure
// ---------------------------------------------------------------------------
// For every entity mentioned in the window we report how many headlines hit it, the
// relevance-weighted net sentiment, the loudest severity seen, and a single "pressure"
// number in [-1, 1] that the bias meter can consume directly.
function aggregateNewsEntities(items, options = {}) {
  const {
    windowHours = 48,
    now = Date.now(),
    maxEntities = 40,
    topTitles = 3,
  } = options;
  const cutoff = toNumber(now) - windowHours * 3600000;
  const buckets = new Map();

  for (const item of items || []) {
    if (!item) continue;
    const published = toMillis(field(item, 'publishedAt', 'published_at'));
    if (published !== null && published < cutoff) continue;

    const entities = Array.isArray(item.entities) ? item.entities : [];
    if (!entities.length) continue;

    const relevance = clamp(toNumber(field(item, 'relevance', 'relevance')), 0, 1);
    const sentiment = clamp(toNumber(field(item, 'sentiment', 'sentiment')), -1, 1);
    const severity = String(field(item, 'severity', 'severity') || 'LOW').toUpperCase();
    const title = item.title || '';
    const url = field(item, 'url', 'url') || null;
    const source = field(item, 'source', 'source') || null;

    for (const rawEntity of entities) {
      const entity = String(rawEntity || '').toUpperCase().trim();
      if (!entity) continue;

      let bucket = buckets.get(entity);
      if (!bucket) {
        bucket = {
          entity,
          itemCount: 0,
          positive: 0,
          negative: 0,
          neutral: 0,
          weightSum: 0,
          sentimentSum: 0,
          maxSeverity: 'LOW',
          latestAt: null,
          titles: [],
        };
        buckets.set(entity, bucket);
      }

      bucket.itemCount += 1;
      if (sentiment > 0.05) bucket.positive += 1;
      else if (sentiment < -0.05) bucket.negative += 1;
      else bucket.neutral += 1;

      // Floor the weight so a zero-relevance item still counts a little.
      const weight = Math.max(relevance, 0.05);
      bucket.weightSum += weight;
      bucket.sentimentSum += sentiment * weight;

      if (severityRank(severity) > severityRank(bucket.maxSeverity)) bucket.maxSeverity = severity;
      if (published !== null && (bucket.latestAt === null || published > bucket.latestAt)) {
        bucket.latestAt = published;
      }
      if (title) {
        bucket.titles.push({
          title,
          url,
          source,
          relevance,
          sentiment: round(sentiment),
          severity,
          publishedAt: published !== null ? new Date(published).toISOString() : null,
        });
      }
    }
  }

  const rows = [];
  for (const bucket of buckets.values()) {
    const netSentiment = bucket.weightSum > 0 ? bucket.sentimentSum / bucket.weightSum : 0;
    const rank = severityRank(bucket.maxSeverity);
    // A severe cluster presses harder than a quiet one with the same net sentiment.
    const pressure = clamp(netSentiment * (1 + 0.25 * rank), -1, 1);

    const top = bucket.titles
      .slice()
      .sort((a, b) => b.relevance - a.relevance || String(b.publishedAt).localeCompare(String(a.publishedAt)))
      .slice(0, topTitles);

    rows.push({
      symbol: bucket.entity,
      values: {
        entity: bucket.entity,
        itemCount: bucket.itemCount,
        positive: bucket.positive,
        negative: bucket.negative,
        neutral: bucket.neutral,
        netSentiment: round(netSentiment),
        maxSeverity: bucket.maxSeverity,
        severityRank: rank,
        pressure: round(pressure),
        latestAt: bucket.latestAt !== null ? new Date(bucket.latestAt).toISOString() : null,
        topTitles: top,
      },
    });
  }

  // Loudest first: the bias meter only ever reads the head of this list.
  rows.sort((a, b) => b.values.itemCount - a.values.itemCount
    || Math.abs(b.values.pressure) - Math.abs(a.values.pressure)
    || a.values.entity.localeCompare(b.values.entity));

  return rows.slice(0, maxEntities);
}

// ---------------------------------------------------------------------------
// Flow: per-symbol option-flow features
// ---------------------------------------------------------------------------
function emptyFlowBucket(symbol) {
  return {
    symbol,
    ceOiChange: 0,
    peOiChange: 0,
    netOiChange: 0,
    futureOiChange: 0,
    optionCount: 0,
    futureCount: 0,
    longBuildup: 0,
    shortBuildup: 0,
    shortCovering: 0,
    longUnwinding: 0,
    contractCount: 0,
    underlyingOiChange: 0,
    underlyingVolume: 0,
    underlyingPrice: null,
    underlyingRead: null,
    hasUnderlying: false,
    contracts: [],
  };
}

// Turns the flat OI-spurt row list (underlyings + contracts) into one factual feature row per
// symbol. Sums CE and PE open-interest change separately so a later stage can read put/call
// positioning, plus the build-up quadrant mix. Deliberately no direction call.
//
// The contracts endpoint returns both options and futures (futures arrive with optionType "-"
// and strike 0), so the two are counted separately: mixing a futures OI move into a put-call
// ratio would quietly corrupt it.
function computeFlowFeatures(rows, options = {}) {
  const { maxSymbols = 60, topContracts = 3 } = options;
  const bySymbol = new Map();

  for (const row of rows || []) {
    if (!row) continue;
    const symbol = String(row.symbol || '').toUpperCase().trim();
    if (!symbol) continue;

    let agg = bySymbol.get(symbol);
    if (!agg) {
      agg = emptyFlowBucket(symbol);
      bySymbol.set(symbol, agg);
    }

    const oiChange = toNumber(field(row, 'oiChange', 'oi_change'));
    const volume = toNumber(field(row, 'volume', 'volume'));
    const read = String(row.read || '').toUpperCase();
    const scope = String(row.scope || '').toUpperCase();

    if (scope === 'UNDERLYING') {
      agg.hasUnderlying = true;
      agg.underlyingOiChange += oiChange;
      agg.underlyingVolume += volume;
      if (!agg.underlyingRead && read) agg.underlyingRead = read;
      // The underlying value is the spot/futures reference the signal builder anchors a
      // strike against when no broker quote is available.
      const underlyingPrice = nullableNumber(field(row, 'price', 'price'));
      if (underlyingPrice !== null) agg.underlyingPrice = underlyingPrice;
      continue;
    }

    agg.contractCount += 1;
    agg.netOiChange += oiChange;
    const optionType = normalizeOptionType(field(row, 'optionType', 'option_type'));
    if (optionType === 'CE') {
      agg.ceOiChange += oiChange;
      agg.optionCount += 1;
    } else if (optionType === 'PE') {
      agg.peOiChange += oiChange;
      agg.optionCount += 1;
    } else {
      agg.futureCount += 1;
      agg.futureOiChange += oiChange;
    }

    if (read === 'LONG BUILDUP') agg.longBuildup += 1;
    else if (read === 'SHORT BUILDUP') agg.shortBuildup += 1;
    else if (read === 'SHORT COVERING') agg.shortCovering += 1;
    else if (read === 'LONG UNWINDING') agg.longUnwinding += 1;

    const contract = field(row, 'contract', 'contract');
    const strike = field(row, 'strike', 'strike');
    if (contract || strike !== undefined) {
      const strikeNumber = Number(strike);
      agg.contracts.push({
        contract: contract || null,
        kind: optionType ? 'OPTION' : 'FUTURE',
        optionType,
        strike: Number.isFinite(strikeNumber) ? strikeNumber : null,
        expiry: field(row, 'expiry', 'expiry') || null,
        oiChange,
        oi: nullableNumber(field(row, 'oi', 'oi')),
        volume,
        // Traded premium, kept so the signal builder can price a candidate contract from the
        // same factual snapshot instead of reaching for the raw tape.
        price: nullableNumber(field(row, 'price', 'price')),
        read: read || null,
      });
    }
  }

  const out = [];
  for (const agg of bySymbol.values()) {
    const pcrOiChange = agg.ceOiChange !== 0 ? round(agg.peOiChange / agg.ceOiChange) : null;
    const scope = agg.hasUnderlying && agg.contractCount
      ? 'MIXED'
      : (agg.contractCount ? 'CONTRACT' : 'UNDERLYING');

    out.push({
      symbol: agg.symbol,
      values: {
        symbol: agg.symbol,
        scope,
        ceOiChange: agg.ceOiChange,
        peOiChange: agg.peOiChange,
        netOiChange: agg.netOiChange,
        pcrOiChange,
        futureOiChange: agg.futureOiChange,
        optionCount: agg.optionCount,
        futureCount: agg.futureCount,
        longBuildup: agg.longBuildup,
        shortBuildup: agg.shortBuildup,
        shortCovering: agg.shortCovering,
        longUnwinding: agg.longUnwinding,
        contractCount: agg.contractCount,
        underlyingOiChange: agg.underlyingOiChange,
        underlyingVolume: agg.underlyingVolume,
        underlyingPrice: agg.underlyingPrice,
        underlyingRead: agg.underlyingRead,
        topContracts: agg.contracts
          .slice()
          .sort((a, b) => Math.abs(b.oiChange) - Math.abs(a.oiChange))
          .slice(0, topContracts),
      },
    });
  }

  out.sort((a, b) => Math.abs(b.values.netOiChange) - Math.abs(a.values.netOiChange)
    || a.values.symbol.localeCompare(b.values.symbol));

  return out.slice(0, maxSymbols);
}

module.exports = {
  severityRank,
  toMillis,
  normalizeOptionType,
  aggregateNewsEntities,
  computeFlowFeatures,
};
