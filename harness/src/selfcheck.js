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
const {
  buildPlan, computeStage, resolveSignalConfig, DEFAULT_SIGNAL_CONFIG,
} = require('./signals');
const { evaluateRisk, resolveRiskConfig, DEFAULT_RISK_CONFIG, lossStreak } = require('./risk');
const { formatSignal, TelegramClient } = require('./telegram');
const { NewsWorker } = require('./workers/w1-news');
const { FlowWorker } = require('./workers/w2-flow');
const { BiasWorker } = require('./workers/w3-bias');
const { SignalWorker } = require('./workers/w4-signals');
const { RiskWorker } = require('./workers/w5-risk');
const { PublishWorker } = require('./workers/w6-publish');
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
