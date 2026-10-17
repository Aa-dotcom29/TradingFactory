'use strict';

// Worker 3 - bias meter.
//
// Reads the durable feature tables (flow.v1, news.entity.v1, quote.v1) and produces one
// directional verdict per tracked symbol and horizon, persisted to `bias_verdicts` and emitted
// as `bias.verdict`.
//
// It is driven by queue notifications (`news.scored` from W1, `feature.snapshot` from W0/W2)
// but never trusts their payloads: the message only says "inputs changed", and the numbers
// always come from the tables so that a replay produces exactly the same verdict. Verdicts are
// only written when they say something new (direction flip, material score move, or a staleness
// heartbeat), which keeps 24/7 operation from writing an identical row every minute.
//
// Note the topics are consumed by exactly one stage each: W2 takes `flow.snapshot`, W3 takes
// `feature.snapshot`. A work queue is not pub/sub, so two stages must never share a topic.

const config = require('../config');
const db = require('../db');
const queue = require('../queue');
const { TOPICS } = require('../topics');
const { marketSession } = require('../session');
const {
  ENGINE_VERSION,
  DEFAULT_BIAS_CONFIG,
  resolveConfig,
  trackedSymbols,
  verdictsForSymbol,
  isMaterialChange,
} = require('../bias');

const log = require('../logger').child({ module: 'w3' });

const TRIGGER_TOPICS = [TOPICS.NEWS_SCORED, TOPICS.FEATURE_SNAPSHOT];

class BiasWorker {
  constructor(options = {}) {
    this.workerName = options.workerName || config.workerName;
    this.batchSize = options.batchSize || 25;
    this.maxPerDrain = options.maxPerDrain || 500;
    this.leaseSeconds = options.leaseSeconds || 120;
    // Even with no triggers, refresh the verdicts on this clock so the price signal stays
    // current and the age of every verdict stays visible.
    this.recomputeStaleMs = options.recomputeStaleMs || 120000;
    this.configTtlMs = options.configTtlMs || 60000;
    this.dryRun = options.dryRun ?? config.dryRun;
    this.lastComputeAt = 0;
    this.configCache = null;
    this.configCacheAt = 0;
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

  // The approved config lives in config_registry. If none exists yet, the built-in baseline is
  // registered so that whatever is running is always visible and supersedeable without a deploy.
  async ensureConfig(options = {}) {
    const now = options.now ?? Date.now();
    if (this.configCache && now - this.configCacheAt < this.configTtlMs) return this.configCache;

    const fallback = { version: DEFAULT_BIAS_CONFIG.version, config: resolveConfig(null) };
    const sql = this.sql;
    if (!sql) return fallback;

    let resolved;
    try {
      const rows = await sql`
        select version, config
        from config_registry
        where status = 'approved' and family = 'bias'
        order by approved_at desc nulls last, created_at desc
        limit 1
      `;
      if (rows.length) {
        resolved = { version: rows[0].version, config: resolveConfig(rows[0].config) };
      } else {
        const version = DEFAULT_BIAS_CONFIG.version;
        await sql`
          insert into config_registry (version, family, created_by, status, metrics, config, approved_at)
          values (${version}, 'bias', 'harness', 'approved', ${sql.json({ seeded: true })},
                  ${sql.json(DEFAULT_BIAS_CONFIG)}, now())
          on conflict (version) do nothing
        `;
        resolved = { version, config: resolveConfig(DEFAULT_BIAS_CONFIG) };
      }
    } catch (error) {
      log.warn('could not resolve bias config, using built-in baseline', { error: error.message });
      resolved = fallback;
    }

    this.configCache = resolved;
    this.configCacheAt = now;
    return resolved;
  }

  // Latest values per symbol for one feature set. The durable table is the single source of
  // truth, so a replayed run produces identical verdicts. Provenance is carried alongside the
  // values so a verdict can record whether its quote was live or delayed.
  async latestFeatureMap(featureSet) {
    const sql = this.sql;
    const rows = await sql`
      select symbol, values, as_of, provenance
      from features
      where feature_set = ${featureSet}
        and as_of = (select max(as_of) from features where feature_set = ${featureSet})
    `;
    const map = new Map();
    const provenance = new Map();
    let asOf = null;
    for (const row of rows) {
      if (!map.has(row.symbol)) {
        map.set(row.symbol, row.values);
        provenance.set(row.symbol, row.provenance || null);
      }
      if (!asOf || row.as_of > asOf) asOf = row.as_of;
    }
    return { asOf, map, provenance };
  }

  async loadPriorVerdicts() {
    const sql = this.sql;
    const rows = await sql`
      select distinct on (horizon, symbol)
        horizon, symbol, direction, score, confidence, as_of
      from bias_verdicts
      order by horizon, symbol, as_of desc
    `;
    const map = new Map();
    for (const row of rows) map.set(`${row.horizon}|${row.symbol}`, row);
    return map;
  }

  async recompute(options = {}) {
    const now = options.now ?? Date.now();
    const summary = { computed: 0, persisted: 0, emitted: 0, configVersion: null };
    if (this.dryRun) {
      log.info('bias recompute (dry run)');
      return summary;
    }
    const sql = this.sql;
    if (!sql) return { ...summary, skipped: 'no-database' };

    try {
      const { version, config: biasConfig } = await this.ensureConfig({ now });
      summary.configVersion = version;

      const [flowSet, newsSet, quoteSet] = await Promise.all([
        this.latestFeatureMap('flow.v1'),
        this.latestFeatureMap('news.entity.v1'),
        this.latestFeatureMap('quote.v1'),
      ]);

      const newsEntities = [...newsSet.map.entries()].map(([symbol, values]) => ({ symbol, values }));
      const universe = trackedSymbols({ config, newsEntities });
      const features = { flow: flowSet.map, news: newsSet.map, quote: quoteSet.map };
      // The session decides whether a price read is a live tick or a settled prior. The meter
      // never asks the clock itself, so a replayed `now` reproduces the same verdicts.
      const session = marketSession(now);

      const verdicts = [];
      for (const symbol of universe) {
        for (const verdict of verdictsForSymbol({
          symbol,
          features,
          config: biasConfig,
          now,
          marketOpen: session.open,
          quoteAsOf: quoteSet.asOf,
          flowAsOf: flowSet.asOf,
          newsAsOf: newsSet.asOf,
        })) {
          // A verdict with no evidence at all is not a verdict; skip rather than publish a
          // NEUTRAL that only means "we know nothing about this symbol".
          const anyEvidence = Object.values(verdict.components).some((component) => component.available);
          if (anyEvidence) verdicts.push(verdict);
        }
      }
      summary.computed = verdicts.length;

      if (!verdicts.length) {
        await this.markSource('bias-meter', 'WARNING', `no evidence for any tracked symbol (config ${version})`);
        return summary;
      }

      const prior = await this.loadPriorVerdicts();
      const changed = verdicts.filter((verdict) => isMaterialChange(
        prior.get(`${verdict.horizon}|${verdict.symbol}`),
        verdict,
        biasConfig.materialChange,
        now,
      ));

      if (changed.length) {
        const asOf = new Date(now).toISOString();
        await sql`
          insert into bias_verdicts ${sql(changed.map((verdict) => ({
            as_of: asOf,
            symbol: verdict.symbol,
            horizon: verdict.horizon,
            direction: verdict.direction,
            score: verdict.score,
            confidence: verdict.confidence,
            coverage: verdict.coverage,
            components: verdict.components,
            evidence: verdict.evidence,
            config_version: version,
            engine_version: ENGINE_VERSION,
            provenance: quoteSet.provenance.get(verdict.symbol) || null,
          })))}
        `;

        for (const verdict of changed) {
          await queue.enqueue(TOPICS.BIAS, {
            symbol: verdict.symbol,
            horizon: verdict.horizon,
            direction: verdict.direction,
            score: verdict.score,
            confidence: verdict.confidence,
            coverage: verdict.coverage,
            asOf,
            marketOpen: session.open,
            flowAsOf: flowSet.asOf ? new Date(flowSet.asOf).toISOString() : null,
            configVersion: version,
            engineVersion: ENGINE_VERSION,
            quoteProvenance: quoteSet.provenance.get(verdict.symbol) || null,
            evidence: verdict.evidence,
          }, {
            idemKey: `bias:${verdict.horizon}:${verdict.symbol}:${asOf}`,
            horizon: verdict.horizon,
          });
        }
      }

      summary.persisted = changed.length;
      summary.emitted = changed.length;

      const counts = changed.reduce((acc, v) => {
        acc[v.direction] = (acc[v.direction] || 0) + 1;
        return acc;
      }, {});
      await this.markSource(
        'bias-meter',
        'HEALTHY',
        `${changed.length} new / ${verdicts.length} verdicts (${universe.length} symbols, config ${version}) `
        + `BULLISH=${counts.BULLISH || 0} BEARISH=${counts.BEARISH || 0} NEUTRAL=${counts.NEUTRAL || 0}`,
      );
      return summary;
    } catch (error) {
      await this.markSource('bias-meter', 'ERROR', error.message);
      log.error('bias recompute failed', { error: error.message });
      return { ...summary, error: error.message };
    }
  }

  // The queue messages are triggers, not payloads: W3 recomputes once per tick after draining
  // whatever arrived, reading the durable tables for the numbers.
  async drain(options = {}) {
    const max = options.max ?? this.maxPerDrain;
    const summary = { triggers: 0, newsTriggers: 0, featureTriggers: 0, failed: 0, batches: 0 };
    if (this.dryRun) {
      log.info('bias drain (dry run)');
      return summary;
    }
    if (!this.sql) {
      log.warn('bias drain skipped: no database connection');
      return summary;
    }

    for (const topic of TRIGGER_TOPICS) {
      let handled = 0;
      while (handled < max) {
        const messages = await queue.reserve(
          topic,
          this.workerName,
          Math.min(this.batchSize, max - handled),
          this.leaseSeconds,
        );
        if (!messages.length) break;
        summary.batches += 1;

        for (const message of messages) {
          try {
            await queue.ack(message.id);
            handled += 1;
            summary.triggers += 1;
          } catch (error) {
            summary.failed += 1;
            log.warn('could not clear bias trigger', { id: message.id, error: error.message });
          }
        }
      }
      if (topic === TOPICS.NEWS_SCORED) summary.newsTriggers = handled;
      else summary.featureTriggers = handled;
    }
    return summary;
  }

  async runOnce(options = {}) {
    const drained = await this.drain(options);
    const triggered = drained.triggers > 0;
    const stale = Date.now() - this.lastComputeAt >= this.recomputeStaleMs;

    if (!options.force && !triggered && !stale) {
      return { ...drained, computed: 0, persisted: 0, emitted: 0, skippedCompute: true };
    }

    const computed = await this.recompute(options);
    if (!computed.error) this.lastComputeAt = Date.now();
    return { ...drained, ...computed };
  }
}

module.exports = { BiasWorker };
