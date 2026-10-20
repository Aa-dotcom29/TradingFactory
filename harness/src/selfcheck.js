'use strict';

// Self-check: validates wiring without needing broker credentials. Runs the pure pipeline
// functions, then (if DATABASE_URL is set) verifies the schema and performs a queue
// round-trip. Exits non-zero on failure so it can gate a deploy.

const config = require('./config');
const db = require('./db');
const queue = require('./queue');
const { TOPICS } = require('./topics');
const { toNewsItem, dedupeHash, resolveEntities, scoreSentiment, classifySeverity } = require('./normalize');
const { aggregateNewsEntities, computeFlowFeatures } = require('./intel');
const { combineVerdict, newsSignal, flowSignal, priceSignal, resolveConfig } = require('./bias');
const { toQuotePayload, toAngelExpiry } = require('./sources/angel-quote');
const { AngelClient } = require('./sources/angel-client');
const { resolvePublishMode } = require('./publish-mode');
const {
  buildPlan, computeStage, resolveSignalConfig, DEFAULT_SIGNAL_CONFIG, selectContract,
} = require('./signals');
const {
  evaluateRisk, resolveRiskConfig, DEFAULT_RISK_CONFIG, lossStreak, marketSession,
} = require('./risk');
const { formatSignal, TelegramClient } = require('./telegram');
const { NewsWorker } = require('./workers/w1-news');
const { FlowWorker } = require('./workers/w2-flow');
const { BiasWorker } = require('./workers/w3-bias');
const { SignalWorker } = require('./workers/w4-signals');
const { RiskWorker } = require('./workers/w5-risk');
const { PublishWorker } = require('./workers/w6-publish');
const { EvaluateWorker, holdingDaysFor } = require('./workers/w7-evaluate');
const { STATUS, evaluateOutcome, scoreOutcomes, proposeConfigChange, PRICE_SOURCE } = require('./outcome');
const { contractKey, matchOptionToken } = require('./contract');
const { IngestWorker } = require('./workers/w0-ingest');
const { batchFingerprint, RepeatTracker, feedState } = require('./freshness');
const rss = require('./sources/rss');
const yahoo = require('./sources/yahoo');

const checks = [];
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`);
};

async function pureFunctionChecks() {
  const item = toNewsItem({
    source: 'test',
    title: 'Reliance Industries beats estimates, profit jumps to record high',
    summary: 'RIL reported strong results and raised guidance.',
    url: 'https://example.com/a?utm_source=x#frag',
    publishedAt: new Date().toISOString(),
  });
  record('normalize.toNewsItem', item.entities.includes('RELIANCE'), `entities=${item.entities.join('|')}`);
  record('sentiment positive', item.sentiment > 0, `sentiment=${item.sentiment}`);
  record('severity classified', ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(item.severity), item.severity);

  const negative = scoreSentiment('Company default triggers NCLT insolvency proceedings, shares plunge');
  record('sentiment negative', negative.score < 0, `sentiment=${negative.score}`);
  record('severity critical', classifySeverity('SEBI bans the promoter after a fraud probe') === 'CRITICAL');

  const a = dedupeHash({ url: 'https://example.com/a?utm_source=x#f1', source: 's', title: 't' });
  const b = dedupeHash({ url: 'https://example.com/a', source: 's', title: 't' });
  record('dedupe canonicalizes url', a === b);

  record('entity aliases', resolveEntities('Tata Consultancy and Infy report').includes('INFY'));

  const xml = '<rss><channel><item><title>A &amp; B</title><link>https://x/y</link><description><![CDATA[<b>hi</b>]]></description><pubDate>Tue, 14 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>';
  const parsed = rss.parseFeed(xml, 'test.com');
  record('rss parse', parsed.length === 1 && parsed[0].title === 'A & B', JSON.stringify(parsed[0] || {}));

  const entities = aggregateNewsEntities([{
    publishedAt: new Date().toISOString(),
    title: 'Reliance beats estimates, profit jumps',
    entities: ['RELIANCE'],
    sentiment: 0.7,
    severity: 'HIGH',
    relevance: 0.8,
  }]);
  record(
    'intel entity aggregation',
    entities.length === 1 && entities[0].values.pressure > 0,
    entities.length ? `pressure=${entities[0].values.pressure}` : 'no rows',
  );

  const flow = computeFlowFeatures([
    { scope: 'CONTRACT', symbol: 'NIFTY', optionType: 'CE', oiChange: 100, read: 'LONG BUILDUP' },
    { scope: 'CONTRACT', symbol: 'NIFTY', optionType: 'PE', oiChange: 50, read: 'SHORT COVERING' },
  ]);
  record(
    'intel flow features',
    flow.length === 1 && flow[0].values.ceOiChange === 100 && flow[0].values.pcrOiChange === 0.5,
    flow.length ? `ce=${flow[0].values.ceOiChange} pcr=${flow[0].values.pcrOiChange}` : 'no rows',
  );

  record(
    'slice 2 worker wiring',
    typeof NewsWorker === 'function' && typeof FlowWorker === 'function'
      && TOPICS.NEWS_SCORED === 'news.scored' && TOPICS.FEATURE_SNAPSHOT === 'feature.snapshot',
  );

  const biasConfig = resolveConfig(null);
  const verdict = combineVerdict({
    symbol: 'NIFTY',
    horizon: 'INTRADAY',
    signals: {
      news: newsSignal({ pressure: 0.5, itemCount: 5, maxSeverity: 'MEDIUM', netSentiment: 0.5 }, biasConfig),
      flow: flowSignal({ longBuildup: 10, shortBuildup: 1, shortCovering: 1, longUnwinding: 0, ceOiChange: 100, peOiChange: 200, optionCount: 12 }, biasConfig),
      price: priceSignal({ ltp: 1010, close: 1000, high: 1012, low: 998 }, biasConfig),
    },
    config: biasConfig,
  });
  record(
    'bias verdict combination',
    verdict.direction === 'BULLISH' && verdict.confidence >= biasConfig.thresholds.minConfidence
      && verdict.coverage === 1 && verdict.evidence.length >= 3,
    `${verdict.direction} score=${verdict.score} confidence=${verdict.confidence}`,
  );

  const withheld = combineVerdict({
    symbol: 'NIFTY',
    horizon: 'POSITIONAL',
    signals: {
      news: newsSignal(null, biasConfig),
      flow: flowSignal(null, biasConfig),
      price: priceSignal(null, biasConfig),
    },
    config: biasConfig,
  });
  record(
    'bias withholds a direction without evidence',
    withheld.direction === 'NEUTRAL' && withheld.confidence === 0,
    `direction=${withheld.direction} confidence=${withheld.confidence}`,
  );

  record(
    'slice 3 worker wiring',
    typeof BiasWorker === 'function' && TOPICS.BIAS === 'bias.verdict' && biasConfig.version === 'bias-v1',
  );

  const signalConfig = resolveSignalConfig(null);
  const flowFeature = {
    underlyingPrice: 25000,
    underlyingVolume: 900000,
    optionCount: 6,
    topContracts: [
      { kind: 'OPTION', optionType: 'CE', strike: 25000, expiry: '27OCT2026', price: 120, oi: 20000, volume: 5000 },
      { kind: 'OPTION', optionType: 'PE', strike: 25000, expiry: '27OCT2026', price: 110, oi: 18000, volume: 4000 },
    ],
  };
  const built = buildPlan({
    symbol: 'NIFTY',
    horizon: 'INTRADAY',
    direction: 'BULLISH',
    flow: flowFeature,
    quote: null,
    config: signalConfig,
    // Pinned: the fixture contracts expire 27 October 2026 and an expired contract is refused, so
    // the wall clock must not decide whether this check passes.
    now: Date.parse('2026-10-14T05:00:00Z'),
  });
  const ready = computeStage({
    verdict: { direction: 'BULLISH', score: 0.5, confidence: 0.6 },
    plan: built.plan,
    planReason: built.reason,
    config: signalConfig,
  });
  record(
    'slice 4 plan + lifecycle',
    built.ok && built.plan.kind === 'OPTION' && built.plan.optionType === 'CE' && ready.stage === 'READY',
    `stage=${ready.stage} entry=${built.plan ? built.plan.entry : 'n/a'} stop=${built.plan ? built.plan.stop : 'n/a'}`,
  );

  const withheldStage = computeStage({
    verdict: { direction: 'NEUTRAL', score: 0, confidence: 0 },
    plan: built.plan,
    config: signalConfig,
  });
  record(
    'slice 4 withholds READY without a directional verdict',
    withheldStage.stage === 'IDLE',
    `stage=${withheldStage.stage}`,
  );

  // A flow snapshot outlives the session that made it, so the contracts it names can expire while
  // the bias meter is still ageing them. Selecting one prices a plan at a dead contract's last
  // trade: on 20 October 2026 that produced a 0.05 NIFTY put whose levels were, fatally, in order.
  const expiredPick = selectContract({
    direction: 'BEARISH',
    spot: 22850,
    flow: {
      topContracts: [
        { kind: 'OPTION', optionType: 'PE', strike: 22850, expiry: '19OCT2026', price: 0.05 },
      ],
    },
    config: signalConfig,
    now: Date.parse('2026-10-20T05:07:00Z'),
  });
  record(
    'slice 10 an expired contract is refused, not priced at its last trade',
    expiredPick.ok === false && /has expired/.test(expiredPick.reason || ''),
    `ok=${expiredPick.ok} reason=${expiredPick.reason}`,
  );

  record(
    'slice 4 worker wiring',
    typeof SignalWorker === 'function'
      && TOPICS.SIGNAL_CANDIDATE === 'signal.candidate'
      && DEFAULT_SIGNAL_CONFIG.version === 'signal-v1',
  );

  const riskConfig = resolveRiskConfig(null);
  const riskCandidate = {
    horizon: 'SWING',
    symbol: 'NIFTY',
    direction: 'BULLISH',
    confidence: 0.6,
    rr: 2,
    liquidity_ok: true,
    as_of: new Date().toISOString(),
  };
  const openSession = { session: { open: true, reason: null } };
  const approved = evaluateRisk({ candidate: riskCandidate, context: openSession, config: riskConfig });
  record(
    'slice 5 risk gate approves a clean candidate',
    approved.decision === 'APPROVED' && approved.approved === true
      && approved.checks.some((check) => check.status === 'SKIPPED'),
    `decision=${approved.decision} gates=${approved.checks.length}`,
  );

  const deferred = evaluateRisk({
    candidate: riskCandidate,
    context: { session: { open: false, reason: 'after the NSE close' } },
    config: riskConfig,
  });
  record(
    'slice 5 risk gate defers outside the session',
    deferred.decision === 'DEFERRED' && deferred.approved === false,
    `decision=${deferred.decision}`,
  );

  const rejected = evaluateRisk({
    candidate: { ...riskCandidate, confidence: 0.05, liquidity_ok: false },
    context: openSession,
    config: riskConfig,
  });
  record(
    'slice 5 risk gate rejects on a failed gate',
    rejected.decision === 'REJECTED' && rejected.failures.length >= 2,
    `decision=${rejected.decision} failures=${rejected.failures.join('|')}`,
  );

  record('slice 5 loss streak math', lossStreak([{ pnl_pct: -1 }, { pnl_pct: -2 }, { pnl_pct: 1 }]) === 2);

  const shadow = new TelegramClient({ token: '', chatId: '', mode: 'shadow' });
  const composed = formatSignal({
    horizon: 'SWING', symbol: 'NIFTY', direction: 'BULLISH', kind: 'OPTION',
    instrument: 'NIFTY 27OCT2026 25000 CE', entry: 120, stop: 84, target: 192,
    rr: 2, confidence: 0.6, strategy_version: 'signal-v1',
  }, { mode: 'shadow' });
  record(
    'slice 5 telegram message composed in shadow',
    shadow.shadow === true && composed.includes('SHADOW') && composed.includes('Execution is always manual')
      && !/[^\x00-\x7F]/.test(composed),
  );

  record(
    'slice 5 worker wiring',
    typeof RiskWorker === 'function' && typeof PublishWorker === 'function'
      && TOPICS.SIGNAL_APPROVED === 'signal.approved' && DEFAULT_RISK_CONFIG.version === 'risk-v1',
  );

  record(
    'slice 5.5 yahoo symbol mapping',
    yahoo.yahooSymbol('NIFTY') === '^NSEI' && yahoo.yahooSymbol('RELIANCE') === 'RELIANCE.NS',
  );

  const yahooQuote = yahoo.parseChart({
    chart: {
      result: [{
        meta: {
          symbol: '^NSEI', currency: 'INR', regularMarketPrice: 23146.15,
          chartPreviousClose: 22622.7, regularMarketDayHigh: 23149.85, regularMarketDayLow: 22913.8,
        },
        indicators: { quote: [{ open: [22900], close: [23146.15] }] },
      }],
    },
  }, 'NIFTY');
  record(
    'slice 5.5 yahoo chart parse',
    yahooQuote && yahooQuote.ltp === 23146.15 && yahooQuote.close === 22622.7
      && yahooQuote.provenance === 'yahoo-delayed' && yahooQuote.exchange === 'NSE',
    yahooQuote ? `ltp=${yahooQuote.ltp} prevClose=${yahooQuote.close}` : 'no quote',
  );

  record(
    'slice 5.5 price signal reads the fallback quote',
    priceSignal({ ltp: yahooQuote.ltp, close: yahooQuote.close, high: yahooQuote.high, low: yahooQuote.low }, biasConfig).available === true,
  );

  const angelPayload = toQuotePayload({
    ltp: 568.2, open: 567.4, high: 569.35, low: 566.1, close: 567.4, tradeVolume: 3556150,
    opnInterest: 12, exchange: 'NSE', exchFeedTime: '21-Jun-2023 10:46:10', exchTradeTime: '21-Jun-2023 10:46:09',
  });
  record(
    'angel quote mapping stamps the exchange feed time',
    angelPayload.ltp === 568.2 && angelPayload.close === 567.4 && angelPayload.openInterest === 12
      && angelPayload.quoteTime === '2023-06-21T05:16:10.000Z',
    `ltp=${angelPayload.ltp} openInterest=${angelPayload.openInterest} quoteTime=${angelPayload.quoteTime}`,
  );

  // Guards two bugs the preflight caught on first run: a field shadowing publicIp(), and the
  // optionGreek endpoint being sent an ISO expiry instead of DDMMMYYYY.
  const angelClient = new AngelClient();
  record(
    'angel client keeps publicIp() callable (not shadowed by a field)',
    typeof angelClient.publicIp === 'function',
    `typeof publicIp=${typeof angelClient.publicIp}`,
  );
  record(
    'angel optionGreek expiry is sent as DDMMMYYYY',
    toAngelExpiry('2026-10-19') === '19OCT2026' && toAngelExpiry('25JAN2024') === '25JAN2024',
    `iso=${toAngelExpiry('2026-10-19')} compact=${toAngelExpiry('25JAN2024')}`,
  );

  // Slice 8: the option identity has to be the same string on both sides (W0 writes the premium
  // series under it, W7 reads it back), and the match has to undo the broker's x100 strike.
  const optionTarget = { symbol: 'NIFTY 50', expiry: '19-Oct-2026', strike: 23150, optionType: 'CE' };
  const optionKey = contractKey(optionTarget);
  const optionMatch = matchOptionToken([{
    token: '47169', symbol: 'NIFTY19OCT2623150CE', name: 'NIFTY', expiry: '19OCT2026',
    strike: '2315000.000000', exch_seg: 'NFO', instrumenttype: 'OPTIDX', lotsize: '65',
  }], optionTarget);
  record(
    'option contract identity round-trips from the universe symbol to an NFO token',
    optionKey === 'NIFTY|2026-10-19|23150|CE' && Boolean(optionMatch) && optionMatch.token === '47169',
    `key=${optionKey} token=${optionMatch ? optionMatch.token : 'none'}`,
  );

  // The premium series only scores the plan if the two refer to the same instrument, and the
  // refusal survives a caller handing over the wrong one.
  const optionScored = evaluateOutcome({
    signal: {
      horizon: 'SWING', symbol: 'NIFTY 50', direction: 'BULLISH', instrument: 'NIFTY 19OCT2026 23150 CE',
      strike: 23150, option_type: 'CE', entry: 100, target: 110, stop: 95,
      publishedAt: '2026-10-14T05:00:00Z', snapshot: { plan: { kind: 'OPTION', expiry: '19-Oct-2026' } },
    },
    path: [{ at: '2026-10-14T05:10:00Z', price: 112 }],
    priceSource: PRICE_SOURCE.OPTION,
    holdingDays: 30,
    now: Date.parse('2026-10-14T06:00:00Z'),
  });
  const optionRefused = evaluateOutcome({
    signal: {
      horizon: 'SWING', symbol: 'NIFTY 50', direction: 'BULLISH', instrument: 'NIFTY 19OCT2026 23150 CE',
      strike: 23150, option_type: 'CE', entry: 100, target: 110, stop: 95,
      publishedAt: '2026-10-14T05:00:00Z', snapshot: { plan: { kind: 'OPTION', expiry: '19-Oct-2026' } },
    },
    path: [{ at: '2026-10-14T05:10:00Z', price: 112 }],
    priceSource: PRICE_SOURCE.UNDERLYING,
    holdingDays: 30,
    now: Date.parse('2026-10-14T06:00:00Z'),
  });
  record(
    'slice 8 an option plan is scored on its premium series and refused the spot one',
    optionScored.status === STATUS.CLOSED && optionScored.result === 'TARGET'
      && optionScored.priceSource === PRICE_SOURCE.OPTION
      && optionRefused.status === STATUS.AWAITING_PRICE_SOURCE,
    `scored=${optionScored.status}/${optionScored.result} refused=${optionRefused.status}`,
  );

  // The market view and the position side are different questions. A bearish view buys a put, and
  // a bought put is long premium, so its target sits above its entry. Reading the view as the side
  // made every option plan unevaluable - and it warned about it every fifteen seconds.
  const putPlan = evaluateOutcome({
    signal: {
      horizon: 'SWING', symbol: 'NIFTY 50', direction: 'BEARISH', instrument: 'NIFTY 19OCT2026 23150 PE',
      strike: 23150, option_type: 'PE', entry: 100, target: 110, stop: 95,
      publishedAt: '2026-10-14T05:00:00Z',
      snapshot: { plan: { kind: 'OPTION', position: 'LONG', expiry: '19-Oct-2026' } },
    },
    path: [{ at: '2026-10-14T05:10:00Z', price: 112 }],
    priceSource: PRICE_SOURCE.OPTION,
    holdingDays: 30,
    now: Date.parse('2026-10-14T06:00:00Z'),
  });
  record(
    'slice 10 a bearish option plan is judged as the long position it is',
    putPlan.status === STATUS.CLOSED && putPlan.result === 'TARGET' && putPlan.pnlPct === 10
      && putPlan.side === 'LONG' && putPlan.direction === 'BEARISH',
    `status=${putPlan.status} side=${putPlan.side} pnl=${putPlan.pnlPct}`,
  );

  // Publishing is switchable per horizon, which is what allows Intraday to be turned on last.
  const publishEnv = { PUBLISH_MODE: 'shadow', PUBLISH_MODE_SWING: 'live' };
  record(
    'publish mode resolves per horizon, Intraday last',
    resolvePublishMode('SWING', publishEnv) === 'live'
      && resolvePublishMode('INTRADAY', publishEnv) === 'shadow'
      && resolvePublishMode('POSITIONAL', publishEnv) === 'shadow',
  );

  const T_Q = Date.parse('2026-10-14T04:00:00Z'); // Wednesday 09:30 IST
  const agedQuote = priceSignal(
    { ltp: 1010, close: 1000, high: 1012, low: 998, quoteTime: new Date(T_Q - 50 * 60000).toISOString() },
    biasConfig,
    { now: T_Q, marketOpen: true },
  );
  const shutQuote = priceSignal(
    { ltp: 1010, close: 1000, high: 1012, low: 998 },
    biasConfig,
    { now: Date.parse('2026-10-17T12:00:00Z'), marketOpen: false },
  );
  record(
    'bias price signal ages a stale quote and honours the session',
    agedQuote.confidence < 1 && agedQuote.confidence >= biasConfig.price.staleConfidenceFloor
      && agedQuote.score > 0
      && shutQuote.confidence <= biasConfig.price.closedSessionConfidence,
    `aged=${agedQuote.confidence} closed=${shutQuote.confidence}`,
  );

  // Dussehra, 20 October 2026: a Tuesday, so only the holiday list can close it. Without one the
  // clock reported a live session all day - which is how an open-market risk gate came to approve
  // plans built from the previous session's frozen prices.
  const holidaySession = marketSession(Date.parse('2026-10-20T05:00:00Z'), riskConfig.gates.session);
  const holidayFeed = feedState('2026-10-20T03:37:00Z', {
    now: Date.parse('2026-10-20T05:10:00Z'),
    staleAfterMs: 1000,
  });
  record(
    'slice 10 a published holiday closes the session, the gate and the feed',
    holidaySession.open === false && holidaySession.holiday === '2026-10-20'
      && /holiday/.test(holidaySession.reason)
      && holidayFeed.state === 'CLOSED',
    `open=${holidaySession.open} feed=${holidayFeed.state} reason=${holidaySession.reason}`,
  );

  const T_SHUT = Date.parse('2026-10-17T12:00:00Z'); // Saturday, NSE shut
  const agedFlow = flowSignal(
    { longBuildup: 10, shortBuildup: 1, shortCovering: 1, longUnwinding: 0, ceOiChange: 100, peOiChange: 200, optionCount: 12 },
    biasConfig,
    { now: T_SHUT, asOf: new Date(T_SHUT - 20 * 3600000).toISOString(), marketOpen: false },
  );
  const agedNews = newsSignal(
    { pressure: 0.5, itemCount: 6, maxSeverity: 'MEDIUM', netSentiment: 0.5, latestAt: new Date(T_SHUT - 40 * 3600000).toISOString() },
    biasConfig,
    { now: T_SHUT, asOf: T_SHUT },
  );
  const freshNews = newsSignal(
    { pressure: 0.5, itemCount: 6, maxSeverity: 'MEDIUM', netSentiment: 0.5, latestAt: new Date(T_SHUT - 20 * 60000).toISOString() },
    biasConfig,
    { now: T_SHUT, asOf: T_SHUT },
  );
  record(
    'bias flow and news components age and honour the session',
    agedFlow.confidence <= biasConfig.flow.closedSessionConfidence
      && agedNews.confidence < freshNews.confidence
      && freshNews.confidence === 1,
    `flow(closed)=${agedFlow.confidence} news(old)=${agedNews.confidence} news(fresh)=${freshNews.confidence}`,
  );

  // --- Slice 7: the evaluator -------------------------------------------------------------
  const T7 = Date.parse('2026-10-14T05:00:00Z');
  const t7 = (minutes) => new Date(T7 + minutes * 60000).toISOString();
  const swingSignal = {
    horizon: 'SWING', symbol: 'NIFTY', direction: 'BULLISH', instrument: 'SPOT',
    entry: 100, target: 110, stop: 95, publishedAt: t7(0), snapshot: { plan: { kind: 'SPOT' } },
  };

  const closed = evaluateOutcome({
    signal: swingSignal,
    path: [{ at: t7(10), price: 104 }, { at: t7(20), price: 111 }],
    holdingDays: 30,
    now: T7 + 60000,
  });
  record(
    'slice 7 a long reaching its target closes at the target',
    closed.status === STATUS.CLOSED && closed.result === 'TARGET' && closed.exit === 110 && closed.pnlPct === 10,
    `result=${closed.result} exit=${closed.exit} pnl=${closed.pnlPct}`,
  );

  const expired = evaluateOutcome({
    signal: swingSignal,
    path: [{ at: t7(10), price: 101 }],
    holdingDays: 1,
    now: T7 + 2 * 86400000,
  });
  record(
    'slice 7 an expired holding window closes as TIME at the in-window price',
    expired.status === STATUS.CLOSED && expired.result === 'TIME' && expired.exit === 101,
    `result=${expired.result} exit=${expired.exit}`,
  );

  const optionPlan = evaluateOutcome({
    signal: { ...swingSignal, instrument: 'OPTION', strike: 25000, option_type: 'CE' },
    path: [{ at: t7(10), price: 111 }],
    holdingDays: 30,
    now: T7 + 60000,
  });
  record(
    'slice 7 an option-premium plan is refused rather than scored on the underlying',
    optionPlan.status === STATUS.AWAITING_PRICE_SOURCE,
    `status=${optionPlan.status}`,
  );

  const stats7 = scoreOutcomes([
    { pnl_pct: 10, result: 'TARGET', horizon: 'SWING' },
    { pnl_pct: -5, result: 'STOP', horizon: 'SWING' },
  ]);
  record(
    'slice 7 scoring reports a 50% win rate and a negative-breaking expectancy',
    stats7.total === 2 && stats7.winRatePct === 50 && stats7.expectancyPct === 2.5,
    `winRate=${stats7.winRatePct} expectancy=${stats7.expectancyPct}`,
  );

  const guarded = proposeConfigChange({ stats: { total: 2, winRatePct: 0 }, currentConfig: { config: { gates: { minConfidence: 0.4 } } } });
  const proposed7 = proposeConfigChange({
    stats: { total: 40, winRatePct: 20, expectancyPct: -1, avgLossPct: -4, avgMaePct: -6, avgWinPct: 3 },
    currentConfig: { config: { gates: { minConfidence: 0.4 } } },
  });
  record(
    'slice 7 proposals need a sample and only ever tighten, never apply',
    guarded.proposed === false && proposed7.proposed === true
      && proposed7.change.direction === 'tighten' && proposed7.config.gates.minConfidence === 0.45,
    `guarded=${guarded.proposed} proposed=${proposed7.proposed}`,
  );

  record(
    'slice 7 worker wiring and the shared holding window',
    typeof EvaluateWorker === 'function' && TOPICS.PUBLISHED === 'signal.published'
      && holdingDaysFor(DEFAULT_RISK_CONFIG, 'INTRADAY') === 1
      && holdingDaysFor(DEFAULT_RISK_CONFIG, 'SWING') === 30
      && holdingDaysFor(DEFAULT_RISK_CONFIG, 'POSITIONAL') === 180,
  );

  // Slice 9 - a 24/7 harness must not confuse "the exchange is shut" with "the feed has broken",
  // nor archive the same reading every poll until midnight.
  const weekend = Date.parse('2026-10-17T06:00:00Z');
  const w0 = new IngestWorker({
    angel: { quote: async () => { throw new Error('the broker must not be called while shut'); } },
  });
  const market9 = await w0.runMarket(weekend);
  const flow9 = await w0.runFlow(weekend);
  record(
    'slice 9 market-derived polls stop once the exchange is shut',
    market9.skipped === 'market-closed' && flow9.skipped === 'market-closed',
    `market=${market9.skipped || 'ran'} flow=${flow9.skipped || 'ran'}`,
  );

  const tracker9 = new RepeatTracker();
  const batch9 = [{ symbol: 'NIFTY 50', ltp: 25000, quoteTime: '2026-10-19T04:00:00.000Z' }];
  const reordered9 = [{ quoteTime: '2026-10-19T04:00:00.000Z', ltp: 25000, symbol: 'NIFTY 50' }];
  record(
    'slice 9 a frozen feed is recognised rather than re-archived',
    batchFingerprint(batch9) === batchFingerprint(reordered9)
      && tracker9.isRepeat('quote', batch9) === false
      && tracker9.isRepeat('quote', reordered9) === true
      && tracker9.isRepeat('quote', [{ ...batch9[0], ltp: 25001 }]) === false,
  );

  const closed9 = feedState('2026-10-16T10:00:00Z', { now: weekend, staleAfterMs: 1000 });
  record(
    'slice 9 a closed market reads CLOSED so the supervisor is not falsely alarmed overnight',
    closed9.state === 'CLOSED',
    `state=${closed9.state}`,
  );
}

async function databaseChecks() {
  if (!config.database.url) {
    record('database', true, 'DATABASE_URL not set - skipping (dry wiring only)');
    return;
  }
  const sql = await db.connect();
  if (!sql) {
    record('database', false, 'could not connect');
    return;
  }
  const ready = await db.schemaReady();
  record('schema applied', ready, ready ? '' : 'run npm run harness:schema');

  if (ready) {
    const idem = `selfcheck:${Date.now()}`;
    await queue.enqueue(TOPICS.NEWS_RAW, { probe: true }, { idemKey: idem });
    const dup = await queue.enqueue(TOPICS.NEWS_RAW, { probe: true }, { idemKey: idem });
    record('queue idempotency', dup.duplicate === true);

    const reserved = await queue.reserve(TOPICS.NEWS_RAW, 'selfcheck', 1);
    record('queue reserve', reserved.length >= 1, `reserved=${reserved.length}`);
    if (reserved.length) {
      await queue.ack(reserved[0].id);
      record('queue ack', true);
    }

    const depth = await queue.backlog();
    record('queue backlog readable', Number.isInteger(depth.pending), `pending=${depth.pending}`);
  }
}

async function main() {
  console.log('Trading Factory harness self-check');
  console.log(`  env=${config.env} role=${config.role} dryRun=${config.dryRun}`);
  console.log(`  angel configured=${config.angel.configured()}  nse=${config.nse.enabled}  yahoo=${config.yahoo.enabled}  rss feeds=${config.rss.feeds.length}`);
  console.log(`  publish mode=${config.publish.mode}  telegram configured=${config.telegram.configured()}`);

  await pureFunctionChecks();
  await databaseChecks();
  await db.close();

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error('self-check crashed:', error.message);
  await db.close().catch(() => {});
  process.exitCode = 1;
});
