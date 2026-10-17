'use strict';

// Harness entrypoint. Runs the pipeline workers either once for a smoke test or on a
// schedule. Supports --dry (no network, no DB) so CI and self-checks can validate wiring
// without credentials.
//
// Roles:
//   all (default) - every worker in one process. Fine for a single Always Free VM.
//   w0            - ingest only
//   w1            - news scoring + entity features
//   w2            - flow features
//   w3            - bias meter
//   w4            - signal builder (lifecycle + candidates)
//   w5            - risk gate
//   w6            - publisher (Telegram, shadow-first)
//   w7            - evaluator (closes positions, scores outcomes, proposes configs)
//   w8            - supervisor
// Splitting roles lets a busy worker scale out later without changing the code.

const config = require('./config');
const log = require('./logger').child({ module: 'run' });
const db = require('./db');
const { IngestWorker } = require('./workers/w0-ingest');
const { NewsWorker } = require('./workers/w1-news');
const { FlowWorker } = require('./workers/w2-flow');
const { BiasWorker } = require('./workers/w3-bias');
const { SignalWorker } = require('./workers/w4-signals');
const { RiskWorker } = require('./workers/w5-risk');
const { PublishWorker } = require('./workers/w6-publish');
const { EvaluateWorker } = require('./workers/w7-evaluate');
const { Supervisor } = require('./workers/w8-supervisor');

const ROLES = ['all', 'w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8'];

function parseArgs(argv) {
  const flags = { once: false, dry: false, role: null };
  for (const arg of argv) {
    if (arg === '--once') flags.once = true;
    else if (arg === '--dry') flags.dry = true;
    else if (arg.startsWith('--role=')) flags.role = arg.slice('--role='.length);
  }
  return flags;
}

// A tick that did nothing is not news. Logging one line per idle poll would bury the
// interesting cycles in a 24/7 run, so empty ticks drop to debug level.
const ACTIVITY_KEYS = [
  'processed', 'duplicates', 'failed', 'entities', 'items', 'symbols',
  'quotes', 'rows', 'queued', 'purged', 'purgedStale', 'persisted', 'emitted',
  'candidates', 'superseded', 'stages', 'approved', 'rejected', 'deferred', 'published',
  'closed',
];

function idleTick(result) {
  if (!result || typeof result !== 'object' || result.error) return false;
  return ACTIVITY_KEYS.every((key) => !Number(result[key]));
}

function makeGuard(name, fn) {
  let running = false;
  return async () => {
    if (running) {
      log.warn('skipping overlapping run', { job: name });
      return;
    }
    running = true;
    try {
      const result = await fn();
      if (result && typeof result === 'object') {
        const line = { job: name, ...result };
        if (idleTick(result)) log.debug('job idle', line);
        else log.info('job complete', line);
      }
    } catch (error) {
      log.error('scheduled job failed', { job: name, error: error.message });
    } finally {
      running = false;
    }
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.dry) config.dryRun = true;
  if (flags.once) config.once = true;
  if (flags.role) config.role = flags.role;
  if (!ROLES.includes(config.role)) {
    log.error('unknown role', { role: config.role, expected: ROLES.join('|') });
    process.exitCode = 1;
    return;
  }

  log.info('harness starting', {
    role: config.role,
    dryRun: config.dryRun,
    once: config.once,
    env: config.env,
    worker: config.workerName,
  });

  if (!config.dryRun) {
    const sql = await db.connect();
    if (sql) {
      const ready = await db.schemaReady();
      if (!ready) log.error('harness schema not found. Apply harness/db/schema.sql (npm run harness:schema)');
    }
  }

  const has = (role) => config.role === 'all' || config.role === role;
  const ingest = has('w0') ? new IngestWorker() : null;
  const news = has('w1') ? new NewsWorker() : null;
  const flowWorker = has('w2') ? new FlowWorker() : null;
  const bias = has('w3') ? new BiasWorker() : null;
  const signals = has('w4') ? new SignalWorker() : null;
  const risk = has('w5') ? new RiskWorker() : null;
  const publisher = has('w6') ? new PublishWorker() : null;
  const evaluator = has('w7') ? new EvaluateWorker() : null;
  const supervisor = has('w8') ? new Supervisor() : null;

  const timers = [];
  const shutdown = async (signal) => {
    log.info('shutting down', { signal });
    for (const timer of timers) clearInterval(timer);
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (config.once) {
    // Ordered pipeline: each stage produces what the next one consumes.
    if (ingest) log.info('ingest result', await ingest.runAll());
    if (news) log.info('news result', await news.runOnce());
    if (flowWorker) log.info('flow result', await flowWorker.runOnce());
    if (bias) log.info('bias result', await bias.runOnce({ force: true }));
    if (signals) log.info('signal result', await signals.runOnce({ force: true }));
    if (risk) log.info('risk result', await risk.runOnce({ force: true }));
    if (publisher) log.info('publish result', await publisher.runOnce());
    if (evaluator) log.info('evaluate result', await evaluator.runOnce());
    if (supervisor) {
      await supervisor.heartbeat();
      await supervisor.housekeeping();
    }
    await db.close();
    log.info('single cycle complete');
    return;
  }

  if (ingest) {
    await ingest.runAll();
    timers.push(setInterval(makeGuard('market', () => ingest.runMarket()), config.poll.marketMs));
    timers.push(setInterval(makeGuard('flow', () => ingest.runFlow()), config.poll.flowMs));
    timers.push(setInterval(makeGuard('news', () => ingest.runNews()), config.poll.newsMs));
  }
  if (news) {
    await news.runOnce();
    timers.push(setInterval(makeGuard('news-worker', () => news.runOnce()), config.poll.scoreMs));
  }
  if (flowWorker) {
    await flowWorker.runOnce();
    timers.push(setInterval(makeGuard('flow-worker', () => flowWorker.runOnce()), config.poll.scoreMs));
  }
  if (bias) {
    await bias.runOnce({ force: true });
    timers.push(setInterval(makeGuard('bias-worker', () => bias.runOnce()), config.poll.scoreMs));
  }
  if (signals) {
    await signals.runOnce({ force: true });
    timers.push(setInterval(makeGuard('signal-worker', () => signals.runOnce()), config.poll.scoreMs));
  }
  if (risk) {
    await risk.runOnce({ force: true });
    timers.push(setInterval(makeGuard('risk-gate', () => risk.runOnce()), config.poll.scoreMs));
  }
  if (publisher) {
    await publisher.runOnce();
    timers.push(setInterval(makeGuard('publisher', () => publisher.runOnce()), config.poll.scoreMs));
  }
  if (evaluator) {
    await evaluator.runOnce();
    timers.push(setInterval(makeGuard('evaluator', () => evaluator.runOnce()), config.poll.scoreMs));
  }
  if (supervisor) {
    await supervisor.heartbeat();
    timers.push(setInterval(makeGuard('heartbeat', () => supervisor.heartbeat()), config.poll.heartbeatMs));
    timers.push(setInterval(makeGuard('housekeeping', () => supervisor.housekeeping()), 3600000));
  }

  log.info('harness running', {
    marketMs: config.poll.marketMs,
    flowMs: config.poll.flowMs,
    newsMs: config.poll.newsMs,
    scoreMs: config.poll.scoreMs,
    heartbeatMs: config.poll.heartbeatMs,
  });
}

main().catch(async (error) => {
  log.error('harness crashed', { error: error.message });
  await db.close().catch(() => {});
  process.exitCode = 1;
});
