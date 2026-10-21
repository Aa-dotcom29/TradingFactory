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
const { contractKey, matchOptionToken, PRICE_SOURCE } = require('../contract');
const { isMarketOpen } = require('../session');
const { RepeatTracker } = require('../freshness');
const { normalizeUniverseSymbol } = require('../bias');
const { dedupeHash } = require('../normalize');

const log = require('../logger').child({ module: 'w0' });

// The feature set that holds option-premium series, and the batch size one broker quote call
// accepts. Both are named once so the writer (this worker) and the reader (W7) cannot drift.
const OPTION_QUOTE_SET = PRICE_SOURCE.OPTION;
const OPTION_BATCH = 50;

// A batch can only be judged a repeat of an earlier one when every reading carries the exchange's
// own stamp. Without a stamp the harness ages the reading by its capture time (see `bias.js`), so
// storing it again is genuinely new evidence and must not be suppressed.
const allStamped = (rows) => rows.every((r) => r.payload && r.payload.quoteTime);

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
    // Recognises a frozen feed: the market is nominally open (so the session gate passes) but the
    // source is handing back exactly what it gave us last time.
    this.repeats = new RepeatTracker();
    this.startedAt = new Date().toISOString();
  }

  get sql() {
    return db.client();
  }

  async markSource(source, status, detail) {
    const sql = this.sql;
    if (!sql) return;
    const ok = status === 'HEALTHY';
    // Only a real fault stamps last_error_at. A neutral state (IDLE / CLOSED) means there was
    // nothing to do, so it must not leave the dashboard looking like a failure streak.
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

  async ensureTokens() {
    if (!angelConfigured()) return false;
    await this.angel.ensureInstruments();
    if (!this.indexTokens) this.indexTokens = this.angel.resolveIndexTokens();
    if (!this.equityTokens) this.equityTokens = this.angel.resolveEquityTokens(config.universe.equities);
    return Boolean(this.indexTokens.length);
  }

  // One insert path for quotes, whichever provider produced them. Provenance travels with the
  // row into `features`, so a delayed Yahoo read can never be mistaken for a live broker tick.
  //
  // Returns the number of rows actually stored, which is zero when the feed is frozen. Callers must
  // not read that zero as "the source failed": a source can answer and still have nothing new.
  async persistQuotes(rows, { capturedAt, provider, provenance }) {
    const sql = this.sql;
    if (!sql || !rows.length) return 0;
    if (allStamped(rows) && this.repeats.isRepeat('quote', rows)) return 0;
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
    const stored = await this.persistQuotes(rows, {
      capturedAt, provider: 'Angel One SmartAPI', provenance: 'angel-live',
    });
    // `quotes` is what was stored, `fetched` is what the broker answered with. The provider
    // waterfall keys off `fetched`, so a frozen feed is never mistaken for a dead provider.
    return { quotes: stored, fetched: rows.length, provenance: 'angel-live' };
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
    const stored = await this.persistQuotes(rows, {
      capturedAt, provider: yahoo.PROVIDER, provenance: yahoo.PROVENANCE,
    });

    const status = quotes.length ? (errors.length ? 'WARNING' : 'HEALTHY') : 'ERROR';
    await this.markSource(
      'yahoo-quotes',
      status,
      `${quotes.length} delayed quotes${errors.length ? `, ${errors.length} failed` : ''}`,
    );
    return {
      quotes: stored, fetched: quotes.length, failed: errors.length, provenance: yahoo.PROVENANCE,
    };
  }

  // Provider waterfall: the live broker feed first, then the free delayed source, so the pipeline
  // is never left without a quote while the authoritative source is unavailable.
  //
  // The whole cycle is skipped once the exchange is shut. A closed market cannot produce a reading,
  // so polling it would burn broker quota (and NSE's patience) to re-learn the same number, and the
  // repeat guard below would only be papering over the waste. The last in-session reading stands as
  // the last known price. `now` is injectable so the gate is testable.
  async runMarket(now = Date.now()) {
    if (config.dryRun) {
      log.info('market cycle (dry run)', { indices: config.universe.indices.length });
      return { quotes: 0 };
    }
    if (!isMarketOpen(now)) {
      // A closed market is not a fault - but returning silently leaves the last
      // in-session row standing for hours, which makes a dead worker look green.
      // Refresh the rows here so checked_at is a real heartbeat, and say why.
      await this.markSource('angel',
        angelConfigured() ? 'IDLE' : 'DISABLED',
        angelConfigured() ? 'market closed' : 'Angel One credentials not configured');
      await this.markSource('yahoo-quotes',
        config.yahoo.enabled ? 'IDLE' : 'DISABLED',
        config.yahoo.enabled ? 'market closed' : 'Yahoo quotes disabled');
      return { quotes: 0, skipped: 'market-closed' };
    }

    if (angelConfigured()) {
      try {
        const viaAngel = await this.marketViaAngel();
        if (viaAngel.fetched > 0) {
          await this.markSource('angel', 'HEALTHY',
            `${viaAngel.fetched} quotes (${viaAngel.quotes} new)`);
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

  // Option-premium positions need a series of their own: a plan's levels are premiums, and the
  // underlying quote is not one. W0 polls exactly the contracts the harness is currently holding -
  // bounded, and precisely what W7 needs - and persists each premium under `option.quote.v1`,
  // keyed by the contract identity rather than by the underlying symbol.
  //
  // Nothing is enqueued for these rows. The bias meter and the signal builder read `quote.v1`, and
  // an option contract must never be treated as a tradeable symbol in the universe, so the premium
  // series is written and read, never fanned out.
  async loadOpenOptionSignals() {
    const sql = this.sql;
    return sql`
      select s.id, s.symbol, s.strike, s.option_type, s.snapshot
      from active_signals s
      where s.strike is not null
        and s.option_type in ('CE', 'PE')
      order by s.published_at asc
      limit 200
    `;
  }

  async persistOptionQuotes(rows, { capturedAt, provider, provenance }) {
    const sql = this.sql;
    if (!sql || !rows.length) return 0;
    if (allStamped(rows) && this.repeats.isRepeat('option', rows)) return 0;
    await sql`
      insert into market_snapshots ${sql(rows.map((r) => ({
        captured_at: capturedAt, provider, symbol: r.symbol, kind: 'OPTION_QUOTE', payload: r.payload,
      })))}
    `;
    await sql`
      insert into features ${sql(rows.map((r) => ({
        as_of: capturedAt, symbol: r.symbol, feature_set: OPTION_QUOTE_SET, horizon: null,
        values: r.payload, provenance,
      })))}
    `;
    return rows.length;
  }

  // Resolve each held option position to its NFO contract, quote them in one batched call (or a
  // few), and persist the premiums. A contract that cannot be resolved is counted, not guessed at -
  // a wrong contract would be worse than a missing one.
  async runOptionQuotes() {
    if (config.dryRun) {
      log.info('option quote cycle (dry run)');
      return { contracts: 0 };
    }
    if (!angelConfigured()) {
      await this.markSource('angel-options', 'DISABLED', 'Angel One credentials not configured');
      return { contracts: 0, skipped: 'angel-not-configured' };
    }
    if (!this.sql) return { contracts: 0, skipped: 'no-database' };
    // A premium is only meaningful while the exchange is trading; out of hours the broker returns a
    // stale stamp and the row adds nothing W7 can use. Mark IDLE rather than returning silently so
    // the row's checked_at keeps proving the worker is alive.
    if (!isMarketOpen()) {
      await this.markSource('angel-options', 'IDLE', 'market closed');
      return { contracts: 0, skipped: 'market-closed' };
    }

    try {
      await this.ensureTokens();
      const open = await this.loadOpenOptionSignals();
      // No held position means there is no premium to track. Saying so keeps the dashboard honest:
      // returning silently here used to leave a stale WARNING (and its old last_error_at) on the
      // row indefinitely, because nothing ever overwrote it while the book was empty.
      if (!open.length) {
        await this.markSource('angel-options', 'IDLE', 'no open option positions to quote');
        return { contracts: 0, skipped: 'no-open-option-positions' };
      }

      const wanted = new Map();
      const unresolved = [];
      for (const row of open) {
        const plan = (row.snapshot && row.snapshot.plan) || {};
        const target = {
          symbol: row.symbol, expiry: plan.expiry, strike: row.strike, optionType: row.option_type,
        };
        const key = contractKey(target);
        const match = key ? matchOptionToken(this.angel.instruments, target) : null;
        if (!match) {
          unresolved.push(`${row.symbol} ${row.option_type || ''}`.trim());
          continue;
        }
        if (!wanted.has(match.token)) wanted.set(match.token, { key, match });
      }

      if (!wanted.size) {
        await this.markSource('angel-options', 'WARNING',
          `${unresolved.length} open option position(s) could not be resolved to a contract`);
        return { contracts: 0, unresolved: unresolved.length };
      }

      const tokens = [...wanted.keys()];
      const quotes = [];
      for (let i = 0; i < tokens.length; i += OPTION_BATCH) {
        quotes.push(...await this.angel.quote('FULL', { NFO: tokens.slice(i, i + OPTION_BATCH) }));
      }

      const byToken = new Map(quotes.map((q) => [String(q.symbolToken), q]));
      const capturedAt = new Date().toISOString();
      const rows = [];
      for (const [token, info] of wanted) {
        const quote = byToken.get(token);
        if (!quote) continue;
        rows.push({
          symbol: info.key,
          payload: {
            ...toQuotePayload(quote),
            underlying: info.match.name,
            expiry: info.match.expiry,
            strike: info.match.strike,
            optionType: info.match.optionType,
            token,
            tradingSymbol: info.match.tradingSymbol,
            lotSize: info.match.lotSize,
          },
        });
      }

      const stored = await this.persistOptionQuotes(rows, {
        capturedAt, provider: 'Angel One SmartAPI', provenance: 'angel-live',
      });
      // Health reflects whether the broker answered for the contracts we hold; `contracts` reports
      // how many premiums were actually new. A premium that has not moved is not a failure.
      await this.markSource('angel-options', rows.length ? 'HEALTHY' : 'WARNING',
        `${rows.length} contract(s) quoted of ${wanted.size} held, ${unresolved.length} unresolved`);
      return {
        contracts: stored,
        fetched: rows.length,
        held: wanted.size,
        unresolved: unresolved.length,
        provenance: 'angel-live',
      };
    } catch (error) {
      await this.markSource('angel-options', 'ERROR', error.message);
      log.warn('option quote cycle failed', { error: error.message });
      return { contracts: 0, error: error.message };
    }
  }

  async runFlow(now = Date.now()) {
    if (config.dryRun) {
      log.info('flow cycle (dry run)', { source: 'NSE OI spurts' });
      return { rows: 0 };
    }
    if (!config.nse.enabled) return { rows: 0, skipped: 'nse-disabled' };
    // OI-spurt pages are a read of the live market. Out of hours NSE serves the same table it
    // served at the close, so a minute-by-minute poll would archive the identical snapshot all
    // night and re-enqueue W2 for each copy.
    //
    // Unlike the quote and premium series, this one is NOT fingerprint-deduped. Those carry the
    // exchange's own stamp and are aged by it, so dropping an unchanged batch cannot change how the
    // reading ages. An OI-spurt row carries no stamp at all: the harness dates flow evidence by its
    // capture time, so suppressing a capture would quietly age the bias meter's flow component
    // while the market was open. The saving is not worth moving the brain.
    if (!isMarketOpen(now)) {
      // Outside the session there is nothing to capture, but the row still has
      // to prove this worker is alive - otherwise an old WARNING or HEALTHY row
      // reads as current state long after the process stopped.
      await this.markSource('nse-oi-spurts', 'IDLE', 'market closed');
      return { rows: 0, skipped: 'market-closed' };
    }

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
    const [market, flow, news, options] = await Promise.all([
      this.runMarket(), this.runFlow(), this.runNews(), this.runOptionQuotes(),
    ]);
    const ok = !market.error && !flow.error && !news.error && !options.error;
    await this.recordRun({ startedAt, ok, market, flow, news, options });
    return { market, flow, news, options, ok };
  }
}

module.exports = { IngestWorker, allStamped };
