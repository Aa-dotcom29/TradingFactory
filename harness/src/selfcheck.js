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
const { NewsWorker } = require('./workers/w1-news');
const { FlowWorker } = require('./workers/w2-flow');
const rss = require('./sources/rss');

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
  console.log(`  angel configured=${config.angel.configured()}  nse=${config.nse.enabled}  rss feeds=${config.rss.feeds.length}`);

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
