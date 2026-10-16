'use strict';

// Harness entrypoint. Runs the Slice 0 workers (W0 ingestion + W8 supervisor), either once
// for a smoke test or on a schedule. Supports --dry (no network, no DB) so CI and self-checks
// can validate wiring without credentials.

const config = require('./config');
const log = require('./logger').child({ module: 'run' });
const db = require('./db');
const { IngestWorker } = require('./workers/w0-ingest');
const { Supervisor } = require('./workers/w8-supervisor');

function parseArgs(argv) {
  const flags = { once: false, dry: false, role: null };
  for (const arg of argv) {
    if (arg === '--once') flags.once = true;
    else if (arg === '--dry') flags.dry = true;
    else if (arg.startsWith('--role=')) flags.role = arg.slice('--role='.length);
  }
  return flags;
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
      await fn();
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

  const runIngest = config.role === 'all' || config.role === 'w0';
  const runSupervisor = config.role === 'all' || config.role === 'w8';

  const ingest = runIngest ? new IngestWorker() : null;
  const supervisor = runSupervisor ? new Supervisor() : null;

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
    if (ingest) log.info('ingest result', await ingest.runAll());
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
  if (supervisor) {
    await supervisor.heartbeat();
    timers.push(setInterval(makeGuard('heartbeat', () => supervisor.heartbeat()), config.poll.heartbeatMs));
    timers.push(setInterval(makeGuard('housekeeping', () => supervisor.housekeeping()), 3600000));
  }

  log.info('harness running', {
    marketMs: config.poll.marketMs,
    flowMs: config.poll.flowMs,
    newsMs: config.poll.newsMs,
    heartbeatMs: config.poll.heartbeatMs,
  });
}

main().catch(async (error) => {
  log.error('harness crashed', { error: error.message });
  await db.close().catch(() => {});
  process.exitCode = 1;
});
