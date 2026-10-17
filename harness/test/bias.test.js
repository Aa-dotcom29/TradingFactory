'use strict';

// Slice 3 bias meter. Pure functions, so no network, database or broker is involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_BIAS_CONFIG,
  resolveConfig,
  normalizeUniverseSymbol,
  trackedSymbols,
  newsSignal,
  flowSignal,
  priceSignal,
  quoteAgeMinutes,
  combineVerdict,
  verdictsForSymbol,
  isMaterialChange,
} = require('../src/bias');

const config = resolveConfig(null);
const NEWS = { pressure: 0.6, itemCount: 6, maxSeverity: 'MEDIUM', netSentiment: 0.55 };
const BULL_FLOW = { longBuildup: 20, shortBuildup: 2, shortCovering: 2, longUnwinding: 1, ceOiChange: 1000, peOiChange: 2000, optionCount: 12 };
const BEAR_FLOW = { longBuildup: 1, shortBuildup: 20, shortCovering: 1, longUnwinding: 4, ceOiChange: 2000, peOiChange: 500, optionCount: 12 };
const UP_QUOTE = { ltp: 1010, close: 1000, high: 1012, low: 998 };

test('resolveConfig merges a partial stored config over the baseline', () => {
  const merged = resolveConfig({ version: 'bias-v9', thresholds: { direction: 0.3 } });
  assert.equal(merged.version, 'bias-v9');
  assert.equal(merged.thresholds.direction, 0.3);
  assert.equal(merged.thresholds.minConfidence, DEFAULT_BIAS_CONFIG.thresholds.minConfidence);
  assert.deepEqual(merged.weights.INTRADAY, DEFAULT_BIAS_CONFIG.weights.INTRADAY);
});

test('resolveConfig tolerates junk without throwing', () => {
  assert.equal(resolveConfig(null).version, DEFAULT_BIAS_CONFIG.version);
  assert.equal(resolveConfig('nonsense').version, DEFAULT_BIAS_CONFIG.version);
  assert.equal(resolveConfig(undefined).weights.SWING.flow, DEFAULT_BIAS_CONFIG.weights.SWING.flow);
});

test('normalizeUniverseSymbol maps human index names to NSE symbols', () => {
  assert.equal(normalizeUniverseSymbol('NIFTY 50'), 'NIFTY');
  assert.equal(normalizeUniverseSymbol('Bank Nifty'), 'BANKNIFTY');
  assert.equal(normalizeUniverseSymbol('midcap nifty'), 'MIDCPNIFTY');
  assert.equal(normalizeUniverseSymbol('reliance'), 'RELIANCE');
  assert.equal(normalizeUniverseSymbol(''), null);
});

test('trackedSymbols keeps the universe and drops non-tradeable macro labels', () => {
  const symbols = trackedSymbols({
    config: { universe: { indices: ['NIFTY 50', 'BANK NIFTY'], equities: ['RELIANCE'] } },
    newsEntities: [
      { symbol: 'TCS' }, // tradeable, not in the universe
      { symbol: 'MARKET' }, // a concept, not a symbol
      { symbol: 'RUPEE' },
      { symbol: 'SENSEX' },
    ],
  });
  assert.deepEqual(symbols, ['BANKNIFTY', 'NIFTY', 'RELIANCE', 'TCS']);
});

test('newsSignal signs the pressure and scales confidence with coverage', () => {
  const bullish = newsSignal(NEWS, config);
  assert.equal(bullish.available, true);
  assert.ok(bullish.score > 0);
  assert.equal(bullish.confidence, 1); // 6 items vs fullConfidenceAt 5

  const thin = newsSignal({ ...NEWS, itemCount: 1 }, config);
  assert.ok(thin.confidence < 0.5);

  assert.equal(newsSignal(null, config).available, false);
  assert.equal(newsSignal({ itemCount: 3 }, config).available, false); // no pressure value
});

test('newsSignal dampens confidence on a critical event', () => {
  const critical = newsSignal({ ...NEWS, maxSeverity: 'CRITICAL' }, config);
  assert.equal(critical.confidence, config.news.criticalConfidenceFactor);
});

test('flowSignal reads the build-up quadrants with the right sign', () => {
  const bullish = flowSignal(BULL_FLOW, config);
  const bearish = flowSignal(BEAR_FLOW, config);
  assert.ok(bullish.score > 0, `bullish=${bullish.score}`);
  assert.ok(bearish.score < 0, `bearish=${bearish.score}`);
  assert.equal(bullish.available, true);
  assert.equal(flowSignal(null, config).available, false);
  assert.equal(flowSignal({ optionCount: 5 }, config).available, false); // no classified contracts
});

test('flowSignal handles a one-sided or flat put-call leg', () => {
  const onlyCalls = flowSignal({ ...BULL_FLOW, ceOiChange: 1000, peOiChange: 0 }, config);
  const onlyPuts = flowSignal({ ...BULL_FLOW, ceOiChange: 0, peOiChange: 1000 }, config);
  assert.ok(onlyPuts.score > onlyCalls.score);

  const flat = flowSignal({ ...BULL_FLOW, ceOiChange: 0, peOiChange: 0 }, config);
  assert.ok(Number.isFinite(flat.score));
});

test('priceSignal scores a move up from the previous close as positive', () => {
  const up = priceSignal(UP_QUOTE, config);
  const down = priceSignal({ ...UP_QUOTE, ltp: 990 }, config);
  assert.ok(up.score > 0);
  assert.ok(down.score < 0);
  assert.equal(up.confidence, 1);
  assert.equal(priceSignal(null, config).available, false);
  assert.equal(priceSignal({ ltp: 100 }, config).available, false);
});

test('priceSignal ages a quote by its exchange timestamp within a session', () => {
  const now = Date.parse('2026-10-14T04:00:00Z'); // Wednesday 09:30 IST, session open
  const freshQuote = { ...UP_QUOTE, quoteTime: new Date(now - 2 * 60000).toISOString() };
  const staleQuote = { ...UP_QUOTE, quoteTime: new Date(now - 45 * 60000).toISOString() };

  const fresh = priceSignal(freshQuote, config, { now, marketOpen: true });
  const stale = priceSignal(staleQuote, config, { now, marketOpen: true });

  assert.equal(fresh.confidence, 1);
  assert.ok(stale.confidence < fresh.confidence, `fresh=${fresh.confidence} stale=${stale.confidence}`);
  assert.ok(stale.confidence >= config.price.staleConfidenceFloor, `confidence=${stale.confidence}`);
  assert.ok(stale.score > 0, 'the last close still carries direction; only its confidence is cut');
  assert.ok(stale.detail.includes('old'));
});

test('priceSignal stops calling a closed-market close live', () => {
  const now = Date.parse('2026-10-17T12:00:00Z'); // Saturday, NSE shut
  const fridayClose = { ...UP_QUOTE, quoteTime: new Date(now - 18 * 3600000).toISOString() };
  assert.ok(quoteAgeMinutes(fridayClose, { now }) > config.price.maxAgeMinutes);

  const aged = priceSignal(fridayClose, config, { now, marketOpen: false });
  assert.ok(aged.confidence <= config.price.closedSessionConfidence, `confidence=${aged.confidence}`);
  assert.ok(aged.confidence > 0);
  assert.ok(aged.detail.includes('market closed'));

  // A quote with no exchange timestamp of its own (the Angel shape today) is still capped by the
  // session alone, so the fix does not depend on every feed carrying `quoteTime`.
  const undated = priceSignal(UP_QUOTE, config, { now, marketOpen: false });
  assert.ok(undated.confidence <= config.price.closedSessionConfidence, `confidence=${undated.confidence}`);
});

test('verdictsForSymbol will not raise an intraday call from a closed-market close alone', () => {
  const now = Date.parse('2026-10-17T12:00:00Z'); // Saturday
  const features = {
    news: new Map(),
    flow: new Map(),
    quote: new Map([['NIFTY', { ...UP_QUOTE, quoteTime: new Date(now - 18 * 3600000).toISOString() }]]),
  };
  const verdicts = verdictsForSymbol({ symbol: 'NIFTY', features, config, now, marketOpen: false, quoteAsOf: now });
  const intraday = verdicts.find((v) => v.horizon === 'INTRADAY');
  assert.equal(intraday.direction, 'NEUTRAL');
  assert.ok(intraday.confidence < config.thresholds.minConfidence, `confidence=${intraday.confidence}`);
});

test('combineVerdict calls a direction only above the confidence floor', () => {
  const strong = combineVerdict({
    symbol: 'NIFTY',
    horizon: 'INTRADAY',
    signals: {
      news: newsSignal(NEWS, config),
      flow: flowSignal(BULL_FLOW, config),
      price: priceSignal(UP_QUOTE, config),
    },
    config,
  });
  assert.equal(strong.direction, 'BULLISH');
  assert.ok(strong.confidence >= config.thresholds.minConfidence);
  assert.equal(strong.coverage, 1);
  assert.equal(strong.components.flow.available, true);
  assert.ok(strong.evidence.length >= 3);
});

test('combineVerdict withholds a direction when evidence is thin', () => {
  const thin = combineVerdict({
    symbol: 'NIFTY',
    horizon: 'POSITIONAL', // news carries 0.4 of the weight here and is missing
    signals: {
      news: newsSignal(null, config),
      flow: flowSignal(BULL_FLOW, config),
      price: priceSignal(null, config),
    },
    config,
  });
  assert.equal(thin.direction, 'NEUTRAL');
  // Only the flow leg (0.15 of the positional weight) is present, so confidence is scaled to
  // 0.15 - below the floor, which is exactly why the direction is withheld.
  assert.ok(thin.confidence < config.thresholds.minConfidence, `confidence=${thin.confidence}`);
  assert.equal(thin.coverage, 0.15);
  assert.ok(thin.evidence.some((line) => line.includes('withheld')));
});

test('combineVerdict with no evidence at all is neutral with zero confidence', () => {
  const empty = combineVerdict({
    symbol: 'X',
    horizon: 'SWING',
    signals: {
      news: newsSignal(null, config),
      flow: flowSignal(null, config),
      price: priceSignal(null, config),
    },
    config,
  });
  assert.equal(empty.direction, 'NEUTRAL');
  assert.equal(empty.confidence, 0);
  assert.equal(empty.score, 0);
});

test('horizon weights change the verdict for the same inputs', () => {
  const signals = {
    news: newsSignal({ ...NEWS, pressure: -0.9 }, config),
    flow: flowSignal(BULL_FLOW, config),
    price: priceSignal(UP_QUOTE, config),
  };
  const intraday = combineVerdict({ symbol: 'X', horizon: 'INTRADAY', signals, config });
  const positional = combineVerdict({ symbol: 'X', horizon: 'POSITIONAL', signals, config });
  // Bad news weighs 0.4 positionally and only 0.1 intraday, so positional must be weaker.
  assert.ok(positional.score < intraday.score, `intraday=${intraday.score} positional=${positional.score}`);
});

test('verdictsForSymbol emits one verdict per horizon in a stable order', () => {
  const features = {
    news: new Map([['NIFTY', NEWS]]),
    flow: new Map([['NIFTY', BULL_FLOW]]),
    quote: new Map([['NIFTY', UP_QUOTE]]),
  };
  const verdicts = verdictsForSymbol({ symbol: 'NIFTY', features, config });
  assert.deepEqual(verdicts.map((v) => v.horizon), ['INTRADAY', 'SWING', 'POSITIONAL']);
  for (const verdict of verdicts) {
    assert.equal(verdict.symbol, 'NIFTY');
    assert.match(verdict.direction, /^(BULLISH|NEUTRAL|BEARISH)$/);
    assert.ok(verdict.score >= -1 && verdict.score <= 1);
    assert.ok(verdict.confidence >= 0 && verdict.confidence <= 1);
  }
});

test('isMaterialChange only fires on a real move or staleness', () => {
  const gate = config.materialChange;
  const now = Date.parse('2026-10-16T12:00:00.000Z');
  const fresh = { direction: 'BULLISH', score: 0.5, as_of: new Date(now - 60000) };

  assert.equal(isMaterialChange(null, { direction: 'BULLISH', score: 0.5 }, gate, now), true);
  assert.equal(isMaterialChange(fresh, { direction: 'BULLISH', score: 0.51 }, gate, now), false);
  assert.equal(isMaterialChange(fresh, { direction: 'BULLISH', score: 0.7 }, gate, now), true);
  assert.equal(isMaterialChange(fresh, { direction: 'BEARISH', score: 0.5 }, gate, now), true);

  const stale = { direction: 'BULLISH', score: 0.5, as_of: new Date(now - 20 * 60000) };
  assert.equal(isMaterialChange(stale, { direction: 'BULLISH', score: 0.5 }, gate, now), true);
});
