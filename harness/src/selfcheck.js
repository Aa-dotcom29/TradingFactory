'use strict';

// Self-check: validates wiring without needing broker credentials. Runs the pure pipeline
// functions, then (if DATABASE_URL is set) verifies the schema and performs a queue
// round-trip. Exits non-zero on failure so it can gate a deploy.

const config = require('./config');
const db = require('./db');
const queue = require('./queue');
const { TOPICS } = require('./topics');
const { toNewsItem, dedupeHash, resolveEntities, scoreSentiment, classifySeverity } = require('./normalize');
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
