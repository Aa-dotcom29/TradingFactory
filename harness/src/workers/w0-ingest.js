'use strict';

// Worker 0 - ingestion. Fetches raw market data, OI-spurt flow and news, persists the
// time-series snapshots, and enqueues downstream work: news.raw for W1, flow.snapshot for W2
// and feature.snapshot for the analyser. It deliberately does not score sentiment, entities or
// bias - that belongs to later workers. Designed to degrade gracefully: a failing source is
// recorded in sources_health and does not stop the others.

const config = require('../config');
const db = require('../db');
const queue = require('../queue');
const { TOPICS } = require('../topics');
const rss = require('../sources/rss');
const nse = require('../sources/nse');
const yahoo = require('../sources/yahoo');
const { AngelClient, configured: angelConfigured } = require('../sources/angel-client');
const { toQuotePayload } = require('../sources/angel-quote');
const { normalizeUniverseSymbol } = require('../bias');
const { dedupeHash } = require('../normalize');

const log = require('../logger').child({ module: 'w0' });

// The bounded wire form of an OI-spurt row, shared by the flow snapshot message so W2 gets a
// stable shape regardless of how NSE labels its fields.
const flowRow = (r) => ({
  scope: r.scope,
  symbol: r.symbol,
  contract: r.contract,
  optionType: r.optionType,
  strike: r.strike,
  expiry: r.expiry,
  bucket: r.bucket,
  oi: r.oi,
  oiChange: r.oiChange,
  volume: r.volume,
  price: r.price,
  priceChangePct: r.priceChangePct,
  read: r.read,
  spurtScore: r.spurtScore,
});

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

  // One insert path for quotes, whichever provider produced them. Provenance travels with the
  // row into `features`, so a delayed Yahoo read can never be mistaken for a live broker tick.
  async persistQuotes(rows, { capturedAt, provider, provenance }) {
    const sql = this.sql;
    if (!sql || !rows.length) return 0;
    await sql`
      insert into market_snapshots ${sql(rows.map((r) => ({
        captured_at: capturedAt, provider, symbol: r.symbol, kind: 'QUOTE', payload: r.payload,
      })))}
    `;
    await sql`
      insert into features ${sql(rows.map((r) => ({
        as_of: capturedAt,
        symbol: r.symbol,
        feature_set: 'quote.v1',
        horizon: null,
        values: r.payload,
        provenance,
      })))}
    `;
    for (const row of rows) {
      await queue.enqueue(TOPICS.FEATURE_SNAPSHOT, {
        symbol: row.symbol, asOf: capturedAt, values: row.payload, provenance,
      }, { idemKey: `feature:${row.symbol}:${capturedAt}` });
    }
    return rows.length;
  }

  async marketViaAngel() {
    await this.ensureTokens();
    const tokens = [...(this.indexTokens || []), ...(this.equityTokens || [])];
    if (!tokens.length) throw new Error('no instrument tokens resolved');
    const quotes = await this.angel.quote('FULL', { NSE: tokens.map((t) => t.token) });
    const capturedAt = new Date().toISOString();

    const rows = quotes.map((q) => {
      const token = String(q.symbolToken);
      const known = tokens.find((t) => t.token === token);
      return {
        symbol: known ? known.name : (q.tradingSymbol || token),
        payload: toQuotePayload(q),
      };
    });
    await this.persistQuotes(rows, {
      capturedAt, provider: 'Angel One SmartAPI', provenance: 'angel-live',
    });
    return { quotes: rows.length, provenance: 'angel-live' };
  }

  // The free fallback. Yahoo covers the gap while the broker onboarding is unfinished; every row
  // it produces is tagged delayed, so nothing downstream treats it as live.
  async marketViaYahoo() {
    const wanted = [];
    for (const value of [...config.universe.indices, ...config.universe.equities]) {
      const symbol = normalizeUniverseSymbol(value);
      if (symbol && !wanted.includes(symbol)) wanted.push(symbol);
    }
    if (!wanted.length) return { quotes: 0, skipped: 'empty-universe' };

    const { quotes, errors } = await yahoo.fetchQuotes(wanted);
    const capturedAt = new Date().toISOString();
    const rows = quotes.map((q) => ({
      symbol: q.symbol,
      payload: {
        ltp: q.ltp,
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        openInterest: null,
        volume: q.volume,
        exchange: q.exchange,
        currency: q.currency,
        quoteTime: q.quoteTime,
      },
    }));
    await this.persistQuotes(rows, {
      capturedAt, provider: yahoo.PROVIDER, provenance: yahoo.PROVENANCE,
    });

    const status = quotes.length ? (errors.length ? 'WARNING' : 'HEALTHY') : 'ERROR';
    await this.markSource(
      'yahoo-quotes',
      status,
      `${quotes.length} delayed quotes${errors.length ? `, ${errors.length} failed` : ''}`,
    );
    return { quotes: quotes.length, failed: errors.length, provenance: yahoo.PROVENANCE };
  }

  // Provider waterfall: the live broker feed first, then the free delayed source, so the pipeline
  // is never left without a quote while the authoritative source is unavailable.
  async runMarket() {
    if (config.dryRun) {
      log.info('market cycle (dry run)', { indices: config.universe.indices.length });
      return { quotes: 0 };
    }

    if (angelConfigured()) {
      try {
        const viaAngel = await this.marketViaAngel();
        if (viaAngel.quotes > 0) {
          await this.markSource('angel', 'HEALTHY', `${viaAngel.quotes} quotes`);
          return viaAngel;
        }
        log.warn('Angel One returned no quotes; falling back to the free source');
      } catch (error) {
        this.angel.lastError = error.message;
        await this.markSource('angel', 'ERROR', error.message);
        log.error('market cycle via Angel One failed', { error: error.message });
      }
    } else {
      await this.markSource('angel', 'DISABLED', 'Angel One credentials not configured');
    }

    if (!config.yahoo.enabled) return { quotes: 0, skipped: 'no-quote-source' };

    try {
      return await this.marketViaYahoo();
    } catch (error) {
      await this.markSource('yahoo-quotes', 'ERROR', error.message);
      log.error('market cycle via Yahoo failed', { error: error.message });
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
        const capturedAt = new Date().toISOString();
        // Downstream (W2) needs both legs of the option flow per symbol, so the snapshot
        // carries a bounded but representative slice of underlyings and contracts rather
        // than only the top rows by spurt score.
        const byMove = (a, b) => Math.abs(b.oiChange || 0) - Math.abs(a.oiChange || 0);
        const snapshot = {
          capturedAt,
          counts: { underlyings: underlyings.length, contracts: contracts.length },
          underlyings: rows.filter((r) => r.scope === 'UNDERLYING').sort(byMove).slice(0, 60).map(flowRow),
          contracts: rows.filter((r) => r.scope === 'CONTRACT').sort(byMove).slice(0, 100).map(flowRow),
        };
        await queue.enqueue(TOPICS.FLOW_SNAPSHOT, snapshot, {
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
      return { queued: 0, duplicates: 0, total: 0 };
    }
    try {
      const raw = await rss.fetchAll();
      const sql = this.sql;
      let queued = 0;
      let duplicates = 0;

      for (const entry of raw) {
        if (!entry.title) continue;
        if (!sql) {
          queued += 1;
          continue;
        }
        // W0 only fetches and enqueues. Scoring (entities/sentiment/severity), the permanent
        // dedupe registry and persistence all belong to W1. The idempotency key still has to
        // be computed here so a 5-minute poll does not re-enqueue the same headline forever.
        const key = `news:${dedupeHash({ url: entry.url, source: entry.source, title: entry.title })}`;
        const result = await queue.enqueue(TOPICS.NEWS_RAW, {
          source: entry.source,
          url: entry.url,
          title: entry.title,
          summary: entry.summary,
          publishedAt: entry.publishedAt,
          fetchedAt: new Date().toISOString(),
        }, { idemKey: key });
        if (result.queued) queued += 1;
        else duplicates += 1;
      }

      const status = raw.length ? 'HEALTHY' : 'WARNING';
      await this.markSource('rss', status, `${queued} queued / ${duplicates} seen / ${raw.length} fetched`);
      return { queued, duplicates, total: raw.length };
    } catch (error) {
      await this.markSource('rss', 'ERROR', error.message);
      log.error('news cycle failed', { error: error.message });
      return { queued: 0, duplicates: 0, total: 0, error: error.message };
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
