'use strict';

// Worker 0 - ingestion. Fetches raw market data, OI-spurt flow and news, normalizes it,
// persists snapshots/features/news and enqueues downstream work. It never scores bias or
// builds signals; that belongs to later workers. Designed to degrade gracefully: a failing
// source is recorded in sources_health and does not stop the others.

const config = require('../config');
const db = require('../db');
const queue = require('../queue');
const { TOPICS } = require('../topics');
const rss = require('../sources/rss');
const nse = require('../sources/nse');
const { AngelClient, configured: angelConfigured } = require('../sources/angel-client');
const { toNewsItem } = require('../normalize');

const log = require('../logger').child({ module: 'w0' });

class IngestWorker {
  constructor(options = {}) {
    this.workerName = options.workerName || config.workerName;
    this.angel = options.angel || new AngelClient();
    this.indexTokens = null;
    this.equityTokens = null;
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

  async ensureTokens() {
    if (!angelConfigured()) return false;
    await this.angel.ensureInstruments();
    if (!this.indexTokens) this.indexTokens = this.angel.resolveIndexTokens();
    if (!this.equityTokens) this.equityTokens = this.angel.resolveEquityTokens(config.universe.equities);
    return Boolean(this.indexTokens.length);
  }

  async runMarket() {
    if (config.dryRun) {
      log.info('market cycle (dry run)', { indices: config.universe.indices.length });
      return { quotes: 0 };
    }
    if (!angelConfigured()) {
      await this.markSource('angel', 'DISABLED', 'Angel One credentials not configured');
      return { quotes: 0, skipped: 'not-configured' };
    }

    try {
      await this.ensureTokens();
      const tokens = [...(this.indexTokens || []), ...(this.equityTokens || [])];
      if (!tokens.length) throw new Error('no instrument tokens resolved');
      const quotes = await this.angel.quote('FULL', { NSE: tokens.map((t) => t.token) });
      const capturedAt = new Date().toISOString();

      const sql = this.sql;
      if (sql && quotes.length) {
        const rows = quotes.map((q) => {
          const token = String(q.symbolToken);
          const known = tokens.find((t) => t.token === token);
          return {
            symbol: known ? known.name : (q.tradingSymbol || token),
            payload: {
              ltp: Number(q.ltp) || null,
              open: Number(q.open) || null,
              high: Number(q.high) || null,
              low: Number(q.low) || null,
              close: Number(q.close) || null,
              openInterest: Number(q.opnInterest) || null,
              volume: Number(q.tradeVolume) || null,
              exchange: q.exchange || 'NSE',
            },
          };
        });
        // Insert as jsonb array rows in one round trip.
        await sql`
          insert into market_snapshots ${sql(rows.map((r) => ({ captured_at: capturedAt, provider: 'Angel One SmartAPI', symbol: r.symbol, kind: 'QUOTE', payload: r.payload })))}
        `;
        await sql`
          insert into features ${sql(rows.map((r) => ({
            as_of: capturedAt,
            symbol: r.symbol,
            feature_set: 'quote.v1',
            horizon: null,
            values: r.payload,
          })))}
        `;
        for (const row of rows) {
          await queue.enqueue(TOPICS.FEATURE_SNAPSHOT, { symbol: row.symbol, asOf: capturedAt, values: row.payload }, {
            idemKey: `feature:${row.symbol}:${capturedAt}`,
          });
        }
      }
      await this.markSource('angel', 'HEALTHY', `${quotes.length} quotes`);
      return { quotes: quotes.length };
    } catch (error) {
      this.angel.lastError = error.message;
      await this.markSource('angel', 'ERROR', error.message);
      log.error('market cycle failed', { error: error.message });
      return { quotes: 0, error: error.message };
    }
  }

  async runFlow() {
    if (config.dryRun) {
      log.info('flow cycle (dry run)', { source: 'NSE OI spurts' });
      return { rows: 0 };
    }
    if (!config.nse.enabled) return { rows: 0, skipped: 'nse-disabled' };

    try {
      const { underlyings, contracts } = await nse.fetchOiSpurts();
      const rows = [...underlyings, ...contracts].map((r) => ({ ...r, spurtScore: nse.spurtScore(r) }));
      const sql = this.sql;
      if (sql && rows.length) {
        await sql`
          insert into oi_spurts ${sql(rows.map((r) => ({
            captured_at: r.capturedAt,
            source: 'NSE',
            scope: r.scope,
            symbol: r.symbol,
            contract: r.contract,
            oi: r.oi,
            oi_change: r.oiChange,
            volume: r.volume,
            price: r.price,
            price_change_pct: r.priceChangePct,
            spurt_score: r.spurtScore,
            read: r.read,
            option_type: r.optionType,
            strike: r.strike,
            expiry: r.expiry,
            bucket: r.bucket,
            payload: r.payload,
          })))}
        `;
        const top = rows.sort((a, b) => b.spurtScore - a.spurtScore).slice(0, 25);
        await queue.enqueue(TOPICS.FLOW_SNAPSHOT, { capturedAt: new Date().toISOString(), top }, {
          idemKey: `flow:${Math.floor(Date.now() / 60000)}`,
        });
      }
      const status = rows.length ? 'HEALTHY' : 'WARNING';
      await this.markSource('nse-oi-spurts', status, `${rows.length} rows`);
      return { rows: rows.length };
    } catch (error) {
      await this.markSource('nse-oi-spurts', 'ERROR', error.message);
      log.warn('flow cycle failed', { error: error.message });
      return { rows: 0, error: error.message };
    }
  }

  async runNews() {
    if (config.dryRun) {
      log.info('news cycle (dry run)', { feeds: config.rss.feeds.length });
      return { newItems: 0, total: 0 };
    }
    try {
      const raw = await rss.fetchAll();
      const items = raw.map((r) => toNewsItem(r));
      const sql = this.sql;
      let newItems = 0;
      const fresh = [];

      for (const item of items) {
        if (sql) {
          const seen = await sql`
            insert into news_seen (dedupe_hash) values (${item.dedupeHash})
            on conflict (dedupe_hash) do nothing
            returning dedupe_hash
          `;
          if (!seen.length) continue; // duplicate
        }
        newItems += 1;
        fresh.push(item);
        if (sql) {
          await sql`
            insert into news_items (published_at, source, url, title, summary, entities, sentiment, severity, relevance, dedupe_hash)
            values (${item.publishedAt}, ${item.source}, ${item.url}, ${item.title}, ${item.summary},
                    ${sql.json(item.entities)}, ${item.sentiment}, ${item.severity}, ${item.relevance}, ${item.dedupeHash})
          `;
          await queue.enqueue(TOPICS.NEWS_RAW, item, { idemKey: `news:${item.dedupeHash}` });
        }
      }

      await this.markSource('rss', fresh.length ? 'HEALTHY' : 'WARNING', `${newItems} new / ${items.length} fetched`);
      return { newItems, total: items.length };
    } catch (error) {
      await this.markSource('rss', 'ERROR', error.message);
      log.error('news cycle failed', { error: error.message });
      return { newItems: 0, total: 0, error: error.message };
    }
  }

  async recordRun(summary) {
    const sql = this.sql;
    if (!sql) return;
    try {
      await sql`
        insert into ingest_runs (started_at, finished_at, ok, worker, summary)
        values (${summary.startedAt}, now(), ${summary.ok}, ${this.workerName}, ${sql.json(summary)})
      `;
    } catch (error) {
      log.warn('could not record ingest run', { error: error.message });
    }
  }

  async runAll() {
    const startedAt = new Date().toISOString();
    const [market, flow, news] = await Promise.all([this.runMarket(), this.runFlow(), this.runNews()]);
    const ok = !market.error && !flow.error && !news.error;
    await this.recordRun({ startedAt, ok, market, flow, news });
    return { market, flow, news, ok };
  }
}

module.exports = { IngestWorker };
