'use strict';

// Worker 2 - flow features.
//
// Consumes flow.snapshot (the NSE OI-spurt rows the ingest worker captured), reduces them to
// one factual feature row per symbol - CE/PE open-interest change, put-call ratio and the
// build-up quadrant mix - persists them as flow.v1 and emits feature.snapshot per symbol.
//
// It reports what the tape did, never what to do about it. The bias meter turns these into a
// verdict in a later slice.

const config = require('../config');
const db = require('../db');
const queue = require('../queue');
const { TOPICS } = require('../topics');
const { computeFlowFeatures } = require('../intel');
const { marketSession } = require('../session');

const log = require('../logger').child({ module: 'w2' });

// What an empty drain means. While the exchange is shut, no flow snapshot is produced, so there is
// nothing for this worker to build - that is the expected state, not a fault. Reporting WARNING
// there stamped `last_error_at` on every tick of every evening, weekend and holiday and made a
// perfectly idle harness look broken. A closed exchange reads CLOSED, the same word the feed state
// already uses, and the same idea as the risk gate's DEFERRED. An empty drain with the market open
// is still a warning: the poll that should have fed it is the thing that failed.
function drainHealth({ processed = 0, symbols = 0, open = true } = {}) {
  if (!processed && !open) {
    return { status: 'CLOSED', detail: 'no flow snapshots while the exchange is shut' };
  }
  return {
    status: processed ? 'HEALTHY' : 'WARNING',
    detail: `${symbols} symbols from ${processed} snapshot(s)`,
  };
}

class FlowWorker {
  constructor(options = {}) {
    this.workerName = options.workerName || config.workerName;
    this.batchSize = options.batchSize || 20;
    this.maxPerDrain = options.maxPerDrain || 200;
    this.leaseSeconds = options.leaseSeconds || 120;
    this.dryRun = options.dryRun ?? config.dryRun;
    this.startedAt = new Date().toISOString();
  }

  get sql() {
    return db.client();
  }

  async markSource(source, status, detail) {
    const sql = this.sql;
    if (!sql) return;
    const ok = status === 'HEALTHY';
    // CLOSED is idle, not broken: it must not touch last_error_at, or a quiet night would read as a
    // failure streak in the dashboard's freshness columns.
    const fault = status === 'WARNING' || status === 'ERROR';
    await sql`
      insert into sources_health (source, status, detail, last_ok_at, last_error_at, checked_at)
      values (${source}, ${status}, ${detail || null},
              ${ok ? new Date() : null}, ${fault ? new Date() : null}, now())
      on conflict (source) do update set
        status = excluded.status,
        detail = excluded.detail,
        last_ok_at = coalesce(excluded.last_ok_at, sources_health.last_ok_at),
        last_error_at = coalesce(excluded.last_error_at, sources_health.last_error_at),
        checked_at = now()
    `;
  }

  // Reduces one flow.snapshot message into per-symbol features. Idempotent: a retry after a
  // crash replaces the rows for the same as_of instead of duplicating them.
  async processOne(message) {
    const sql = this.sql;
    const payload = message.payload || {};
    const rows = [...(payload.underlyings || []), ...(payload.contracts || [])];
    const features = computeFlowFeatures(rows);
    if (!features.length) return { symbols: 0 };

    const captured = payload.capturedAt ? new Date(payload.capturedAt) : null;
    const asOf = captured && !Number.isNaN(captured.getTime())
      ? captured.toISOString()
      : new Date().toISOString();

    await sql`
      delete from features
      where feature_set = 'flow.v1' and as_of = ${asOf} and horizon is null
    `;
    await sql`
      insert into features ${sql(features.map((f) => ({
        as_of: asOf,
        symbol: f.symbol,
        feature_set: 'flow.v1',
        horizon: null,
        values: f.values,
      })))}
    `;

    for (const f of features) {
      await queue.enqueue(
        TOPICS.FEATURE_SNAPSHOT,
        { symbol: f.symbol, asOf, featureSet: 'flow.v1', values: f.values },
        { idemKey: `feature:${f.symbol}:flow:${asOf}` },
      );
    }

    return { symbols: features.length, asOf };
  }

  async drain(options = {}) {
    const max = options.max ?? this.maxPerDrain;
    const summary = { processed: 0, symbols: 0, failed: 0, batches: 0, asOf: null };
    if (this.dryRun) {
      log.info('flow drain (dry run)');
      return summary;
    }
    if (!this.sql) {
      log.warn('flow drain skipped: no database connection');
      return summary;
    }

    while (summary.processed + summary.failed < max) {
      const remaining = max - (summary.processed + summary.failed);
      const messages = await queue.reserve(
        TOPICS.FLOW_SNAPSHOT,
        this.workerName,
        Math.min(this.batchSize, remaining),
        this.leaseSeconds,
      );
      if (!messages.length) break;
      summary.batches += 1;

      for (const message of messages) {
        try {
          const result = await this.processOne(message);
          summary.processed += 1;
          summary.symbols += result.symbols || 0;
          if (result.asOf) summary.asOf = result.asOf;
          await queue.ack(message.id);
        } catch (error) {
          summary.failed += 1;
          log.warn('flow feature build failed', { id: message.id, error: error.message });
          await queue.nack(message.id, error.message);
        }
      }
    }

    const health = drainHealth({
      processed: summary.processed,
      symbols: summary.symbols,
      open: marketSession().open,
    });
    await this.markSource('flow-features', health.status, health.detail);
    return summary;
  }

  async runOnce() {
    return this.drain();
  }
}

module.exports = { FlowWorker, drainHealth };
