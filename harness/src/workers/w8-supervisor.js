'use strict';

// Worker 8 - supervisor. Watches the health of the whole harness: worker heartbeat, queue
// depth and dead letters, and feed freshness. It is intentionally read-only except for its
// own heartbeat and queue housekeeping, so it can never corrupt pipeline data.

const config = require('../config');
const db = require('../db');
const queue = require('../queue');
const log = require('../logger').child({ module: 'w8' });

class Supervisor {
  constructor(options = {}) {
    this.workerName = options.workerName || config.workerName;
    this.staleAfterMs = options.staleAfterMs || 120000;
    this.startedAt = new Date().toISOString();
  }

  get sql() {
    return db.client();
  }

  async feedFreshness() {
    const sql = this.sql;
    if (!sql) return null;
    const rows = await sql`
      select max(captured_at) as latest from market_snapshots
    `;
    const latest = rows[0]?.latest;
    if (!latest) return { ageMs: null, state: 'NO_DATA' };
    const ageMs = Date.now() - new Date(latest).getTime();
    return { latest, ageMs, state: ageMs > this.staleAfterMs ? 'STALE' : 'FRESH' };
  }

  async snapshot() {
    const sql = this.sql;
    if (!sql) {
      return { database: false, note: 'no database connection; supervisor running in memory only' };
    }
    const [queueStats, dead, freshness, depth] = await Promise.all([
      queue.stats(),
      queue.deadLetters(10),
      this.feedFreshness(),
      queue.backlog(),
    ]);
    const deadCount = dead.length;
    const pending = queueStats
      .filter((r) => r.state === 'pending')
      .reduce((sum, r) => sum + r.count, 0);
    const oldestPendingMs = depth.oldestPendingAt
      ? Date.now() - new Date(depth.oldestPendingAt).getTime()
      : null;
    return {
      database: true,
      queueStats,
      pending,
      deadLetters: deadCount,
      oldestPendingMs,
      freshness,
    };
  }

  async heartbeat() {
    const sql = this.sql;
    const summary = await this.snapshot();
    const state = summary.deadLetters > 0
      ? 'WARNING'
      : summary.freshness && summary.freshness.state === 'STALE' ? 'WARNING' : 'HEALTHY';
    const detail = JSON.stringify({
      pending: summary.pending ?? 0,
      deadLetters: summary.deadLetters ?? 0,
      oldestPendingMin: summary.oldestPendingMs == null ? null : Math.round(summary.oldestPendingMs / 60000),
      feed: summary.freshness ? summary.freshness.state : 'UNKNOWN',
      uptimeSec: Math.round((Date.now() - Date.parse(this.startedAt)) / 1000),
    });

    if (sql) {
      await sql`
        insert into sources_health (source, status, detail, last_ok_at, checked_at)
        values (${'harness-supervisor'}, ${state}, ${detail}, now(), now())
        on conflict (source) do update set
          status = excluded.status, detail = excluded.detail,
          last_ok_at = now(), checked_at = now()
      `;
    }
    if (state !== 'HEALTHY') log.warn('supervisor heartbeat', { state, ...JSON.parse(detail) });
    else log.info('supervisor heartbeat', JSON.parse(detail));
    return summary;
  }

  async housekeeping() {
    if (!this.sql) return { purged: 0, purgedStale: 0 };
    try {
      const [purged, purgedStale] = await Promise.all([
        queue.purgeDone(7),
        queue.purgeStalePending(6),
      ]);
      if (purgedStale) log.warn('dropped stale queued notifications', { purgedStale });
      return { purged, purgedStale };
    } catch (error) {
      log.warn('housekeeping failed', { error: error.message });
      return { purged: 0, purgedStale: 0, error: error.message };
    }
  }
}

module.exports = { Supervisor };
