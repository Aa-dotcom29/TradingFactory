'use strict';

// Worker 1 - news intelligence.
//
// Consumes news.raw (headlines the ingest worker fetched but did not score), applies the
// rule-based scorer, dedupes permanently through news_seen, persists news_items, and emits
// news.scored per item. It then rolls the rolling window up into entity-level features
// (news.entity.v1) that the bias meter and the dashboard read.
//
// The LLM is deliberately absent here: scoring is deterministic and replayable, so a signal
// can always be explained from the stored item alone.

const config = require('../config');
const db = require('../db');
const queue = require('../queue');
const { TOPICS } = require('../topics');
const { toNewsItem } = require('../normalize');
const { aggregateNewsEntities } = require('../intel');

const log = require('../logger').child({ module: 'w1' });

class NewsWorker {
  constructor(options = {}) {
    this.workerName = options.workerName || config.workerName;
    this.batchSize = options.batchSize || 50;
    this.maxPerDrain = options.maxPerDrain || 1000;
    this.entityWindowHours = options.entityWindowHours || 48;
    this.entityLimit = options.entityLimit || 2000;
    // The window rollup does not need the drain cadence: it is re-run after any new item, and
    // otherwise on a slow clock so items still age out of the window.
    this.entityRefreshMs = options.entityRefreshMs || 300000;
    this.lastEntityRollAt = 0;
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
    await sql`
      insert into sources_health (source, status, detail, last_ok_at, last_error_at, checked_at)
      values (${source}, ${status}, ${detail || null},
              ${ok ? new Date() : null}, ${ok ? null : new Date()}, now())
      on conflict (source) do update set
        status = excluded.status,
        detail = excluded.detail,
        last_ok_at = coalesce(excluded.last_ok_at, sources_health.last_ok_at),
        last_error_at = coalesce(excluded.last_error_at, sources_health.last_error_at),
        checked_at = now()
    `;
  }

  // Scores one headline and returns { duplicate: true } when it has already been stored.
  async scoreOne(raw) {
    const sql = this.sql;
    const item = toNewsItem(raw);

    const seen = await sql`
      insert into news_seen (dedupe_hash) values (${item.dedupeHash})
      on conflict (dedupe_hash) do nothing
      returning dedupe_hash
    `;
    if (!seen.length) return { duplicate: true, item };

    await sql`
      insert into news_items (published_at, source, url, title, summary, entities, sentiment, severity, relevance, dedupe_hash)
      values (${item.publishedAt}, ${item.source}, ${item.url}, ${item.title}, ${item.summary},
              ${sql.json(item.entities)}, ${item.sentiment}, ${item.severity}, ${item.relevance}, ${item.dedupeHash})
    `;

    await queue.enqueue(TOPICS.NEWS_SCORED, {
      dedupeHash: item.dedupeHash,
      source: item.source,
      url: item.url,
      title: item.title,
      publishedAt: item.publishedAt,
      entities: item.entities,
      sentiment: item.sentiment,
      severity: item.severity,
      relevance: item.relevance,
    }, { idemKey: `scored:${item.dedupeHash}` });

    return { duplicate: false, item };
  }

  // Drains news.raw until the queue is quiet or the per-run cap is reached.
  async drain(options = {}) {
    const max = options.max ?? this.maxPerDrain;
    const summary = { processed: 0, duplicates: 0, failed: 0, batches: 0 };
    if (this.dryRun) {
      log.info('news drain (dry run)');
      return summary;
    }
    if (!this.sql) {
      log.warn('news drain skipped: no database connection');
      return summary;
    }

    while (summary.processed + summary.duplicates + summary.failed < max) {
      const remaining = max - (summary.processed + summary.duplicates + summary.failed);
      const messages = await queue.reserve(
        TOPICS.NEWS_RAW,
        this.workerName,
        Math.min(this.batchSize, remaining),
        this.leaseSeconds,
      );
      if (!messages.length) break;
      summary.batches += 1;

      for (const message of messages) {
        try {
          const result = await this.scoreOne(message.payload || {});
          if (result.duplicate) summary.duplicates += 1;
          else summary.processed += 1;
          await queue.ack(message.id);
        } catch (error) {
          summary.failed += 1;
          log.warn('news scoring failed', { id: message.id, error: error.message });
          await queue.nack(message.id, error.message);
        }
      }
    }
    return summary;
  }

  // Rolls the window of stored news into per-entity features. Cheap enough to run every
  // cycle and self-correcting: it always recomputes from the table, never from memory.
  async recomputeEntities(options = {}) {
    const now = options.now ?? Date.now();
    const sql = this.sql;
    if (this.dryRun) return { entities: 0, items: 0 };
    if (!sql) return { entities: 0, items: 0, skipped: 'no-database' };

    try {
      const since = new Date(now - this.entityWindowHours * 3600000);
      const items = await sql`
        select published_at, source, url, title, entities, sentiment, severity, relevance
        from news_items
        where published_at > ${since}
        order by published_at desc
        limit ${this.entityLimit}
      `;

      const rows = aggregateNewsEntities(items, { now, windowHours: this.entityWindowHours });
      if (rows.length) {
        const asOf = new Date(now).toISOString();
        await sql`
          insert into features ${sql(rows.map((r) => ({
            as_of: asOf,
            symbol: r.symbol,
            feature_set: 'news.entity.v1',
            horizon: null,
            values: r.values,
          })))}
        `;
      }

      const status = items.length ? 'HEALTHY' : 'WARNING';
      await this.markSource(
        'news-scoring',
        status,
        `${rows.length} entities / ${items.length} items (${this.entityWindowHours}h window)`,
      );
      return { entities: rows.length, items: items.length };
    } catch (error) {
      await this.markSource('news-scoring', 'ERROR', error.message);
      log.error('entity aggregation failed', { error: error.message });
      return { entities: 0, items: 0, error: error.message };
    }
  }

  async runOnce(options = {}) {
    const force = options.force === true;
    const drained = await this.drain();

    const due = Date.now() - this.lastEntityRollAt >= this.entityRefreshMs;
    if (!force && drained.processed === 0 && !due) {
      // Nothing new and the window is still fresh: skip the rollup instead of rewriting an
      // identical snapshot on every poll.
      return { ...drained, entities: 0, items: 0, skippedRoll: true };
    }

    const entities = await this.recomputeEntities();
    if (!entities.error) this.lastEntityRollAt = Date.now();
    return { ...drained, ...entities };
  }
}

module.exports = { NewsWorker };
