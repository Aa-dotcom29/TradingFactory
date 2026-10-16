'use strict';

// Worker 4 - signal builder.
//
// Reads the latest bias verdict per symbol and horizon together with the factual flow and quote
// features, and advances each name along its trade lifecycle:
//
//   IDLE -> WATCH -> BUILDING -> READY
//
// It persists every stage transition (with the reasons behind it) to `signal_stages` and, when a
// name enters READY, writes a concrete tradeable proposal to `signal_candidates` and emits
// `signal.candidate` for the risk gate (W5, a later slice).
//
// Like W3 this stage never trusts queue payloads: the messages only say "the bias changed", and
// all numbers come from the durable tables, so a replay reproduces exactly the same stages and
// candidates. Rows are only written on a material change, so 24/7 operation does not append an
// identical row every minute.
//
// W4 only ever moves a name between the stages it owns. BLOCKED/ACTIVE/EXITED/EXPIRED belong to
// W5/W6/W7; if a name is already in one of those, W4 leaves it alone rather than resetting a
// live position to WATCH on the next tick.

const config = require('../config');
const db = require('../db');
const queue = require('../queue');
const { TOPICS } = require('../topics');
const {
  ENGINE_VERSION,
  DEFAULT_SIGNAL_CONFIG,
  resolveSignalConfig,
  buildPlan,
  planSignature,
  computeStage,
  isStageMaterialChange,
  candidateDedupeKey,
  isOwnedStage,
} = require('../signals');

const log = require('../logger').child({ module: 'w4' });

const TRIGGER_TOPICS = [TOPICS.BIAS];
const CONFIG_FAMILY = 'signal';

class SignalWorker {
  constructor(options = {}) {
    this.workerName = options.workerName || config.workerName;
    this.batchSize = options.batchSize || 25;
    this.maxPerDrain = options.maxPerDrain || 500;
    this.leaseSeconds = options.leaseSeconds || 120;
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

  // Registers the built-in baseline as `signal-v1` in the `signal` family on first run, so the
  // stops, targets and thresholds actually in force are always inspectable and supersedeable.
  async ensureConfig(options = {}) {
    const now = options.now ?? Date.now();
    if (this.configCache && now - this.configCacheAt < this.configTtlMs) return this.configCache;

    const fallback = { version: DEFAULT_SIGNAL_CONFIG.version, config: resolveSignalConfig(null) };
    const sql = this.sql;
    if (!sql) return fallback;

    let resolved;
    try {
      const rows = await sql`
        select version, config
        from config_registry
        where status = 'approved' and family = ${CONFIG_FAMILY}
        order by approved_at desc nulls last, created_at desc
        limit 1
      `;
      if (rows.length) {
        resolved = { version: rows[0].version, config: resolveSignalConfig(rows[0].config) };
      } else {
        const version = DEFAULT_SIGNAL_CONFIG.version;
        await sql`
          insert into config_registry (version, family, created_by, status, metrics, config, approved_at)
          values (${version}, ${CONFIG_FAMILY}, 'harness', 'approved', ${sql.json({ seeded: true })},
                  ${sql.json(DEFAULT_SIGNAL_CONFIG)}, now())
          on conflict (version) do nothing
        `;
        resolved = { version, config: resolveSignalConfig(DEFAULT_SIGNAL_CONFIG) };
      }
    } catch (error) {
      log.warn('could not resolve signal config, using built-in baseline', { error: error.message });
      resolved = fallback;
    }

    this.configCache = resolved;
    this.configCacheAt = now;
    return resolved;
  }

  // Latest values per symbol for one feature set. The durable table is the single source of
  // truth, so a replayed run produces identical plans.
  async latestFeatureMap(featureSet) {
    const sql = this.sql;
    const rows = await sql`
      select symbol, values
      from features
      where feature_set = ${featureSet}
        and as_of = (select max(as_of) from features where feature_set = ${featureSet})
    `;
    const map = new Map();
    for (const row of rows) if (!map.has(row.symbol)) map.set(row.symbol, row.values);
    return map;
  }

  async loadLatestVerdicts() {
    const sql = this.sql;
    return sql`
      select * from (
        select distinct on (horizon, symbol)
          horizon, symbol, direction, score, confidence, as_of
        from bias_verdicts
        order by horizon, symbol, as_of desc
      ) t
      order by horizon, symbol
    `;
  }

  async loadStages() {
    const sql = this.sql;
    const rows = await sql`
      select * from (
        select distinct on (horizon, symbol)
          horizon, symbol, stage, direction, score, plan_signature, as_of
        from signal_stages
        order by horizon, symbol, as_of desc
      ) t
    `;
    const map = new Map();
    for (const row of rows) map.set(`${row.horizon}|${row.symbol}`, row);
    return map;
  }

  // Writes one row per changed stage and returns what happened, so the caller can turn READY
  // entries into candidates without re-deriving anything.
  async persistStages(changed, { version, now }) {
    const sql = this.sql;
    if (!changed.length) return { persisted: 0 };

    const asOf = new Date(now).toISOString();
    await sql`
      insert into signal_stages ${sql(changed.map(({ verdict, next, previous }) => ({
        as_of: asOf,
        symbol: verdict.symbol,
        horizon: verdict.horizon,
        stage: next.stage,
        previous_stage: previous ? previous.stage : null,
        direction: next.direction,
        score: next.score,
        confidence: next.confidence,
        plan_ready: next.planReady,
        liquidity_ok: next.liquidityOk,
        plan: next.plan,
        plan_signature: next.planSignature,
        reasons: next.reasons,
        config_version: version,
        engine_version: ENGINE_VERSION,
      })))}
    `;
    return { persisted: changed.length, asOf };
  }

  // A name leaving the tradeable READY stage invalidates any candidate still awaiting risk.
  async supersedeCandidates(changed) {
    const sql = this.sql;
    const leaving = changed.filter(({ next, previous }) => (
      previous && previous.stage === 'READY' && next.stage !== 'READY'
    ));
    for (const { verdict } of leaving) {
      await sql`
        update signal_candidates
        set status = 'superseded'
        where status = 'pending_risk' and horizon = ${verdict.horizon} and symbol = ${verdict.symbol}
      `;
    }
    return leaving.length;
  }

  // A candidate is raised on a fresh READY entry, or when a name is still READY but its plan
  // changed underneath the verdict (a new strike, a moved stop). A plain score move while READY
  // is not a new candidate.
  async persistCandidates(changed, { version, now, strategy }) {
    const sql = this.sql;
    const entries = changed.filter(({ next, previous }) => {
      if (next.stage !== 'READY' || !next.plan) return false;
      if (!previous || previous.stage !== 'READY') return true;
      return (previous.plan_signature || 'none') !== next.planSignature;
    });

    let emitted = 0;
    for (const { verdict, next, previous } of entries) {
      const plan = next.plan;
      const dedupeKey = candidateDedupeKey({
        horizon: verdict.horizon,
        symbol: verdict.symbol,
        direction: next.direction,
        plan,
        readyAt: now,
      });

      if (previous && previous.stage === 'READY') {
        // The plan changed while READY: retire the stale proposal before raising the new one.
        await sql`
          update signal_candidates
          set status = 'superseded'
          where status = 'pending_risk' and horizon = ${verdict.horizon} and symbol = ${verdict.symbol}
        `;
      }

      const inserted = await sql`
        insert into signal_candidates (
          as_of, horizon, symbol, direction, strategy, strategy_version, engine_version,
          config_version, kind, instrument, strike, option_type, expiry, entry, target, stop, rr,
          confidence, score, liquidity_ok, status, dedupe_key, setup, reasons
        ) values (
          ${new Date(now).toISOString()}, ${verdict.horizon}, ${verdict.symbol}, ${next.direction},
          ${strategy}, ${version}, ${ENGINE_VERSION},
          ${version}, ${plan.kind}, ${plan.instrument}, ${plan.strike}, ${plan.optionType},
          ${plan.expiry}, ${plan.entry}, ${plan.target}, ${plan.stop}, ${plan.rr},
          ${next.confidence}, ${next.score}, ${next.liquidityOk}, 'pending_risk',
          ${dedupeKey}, ${sql.json(plan)}, ${sql.json(next.reasons)}
        )
        on conflict (dedupe_key) do nothing
        returning id
      `;
      if (!inserted.length) continue;

      await queue.enqueue(TOPICS.SIGNAL_CANDIDATE, {
        symbol: verdict.symbol,
        horizon: verdict.horizon,
        direction: next.direction,
        score: next.score,
        confidence: next.confidence,
        kind: plan.kind,
        instrument: plan.instrument,
        strike: plan.strike,
        optionType: plan.optionType,
        expiry: plan.expiry,
        entry: plan.entry,
        target: plan.target,
        stop: plan.stop,
        rr: plan.rr,
        spot: plan.spot,
        liquidity: plan.liquidity,
        asOf: new Date(now).toISOString(),
        configVersion: version,
        engineVersion: ENGINE_VERSION,
        strategy,
        strategyVersion: version,
        reasons: next.reasons,
      }, { idemKey: `cand:${dedupeKey}`, horizon: verdict.horizon });
      emitted += 1;
    }
    return emitted;
  }

  async recompute(options = {}) {
    const now = options.now ?? Date.now();
    const summary = {
      computed: 0, persisted: 0, candidates: 0, superseded: 0, configVersion: null,
    };
    if (this.dryRun) {
      log.info('signal recompute (dry run)');
      return summary;
    }
    const sql = this.sql;
    if (!sql) return { ...summary, skipped: 'no-database' };

    try {
      const { version, config: signalConfig } = await this.ensureConfig({ now });
      summary.configVersion = version;

      const [flowMap, quoteMap, verdicts, stages] = await Promise.all([
        this.latestFeatureMap('flow.v1'),
        this.latestFeatureMap('quote.v1'),
        this.loadLatestVerdicts(),
        this.loadStages(),
      ]);
      summary.computed = verdicts.length;
      if (!verdicts.length) {
        await this.markSource('signal-builder', 'WARNING', `no bias verdicts to build from (config ${version})`);
        return summary;
      }

      const changed = [];
      for (const verdict of verdicts) {
        const key = `${verdict.horizon}|${verdict.symbol}`;
        const previous = stages.get(key) || null;

        // A name that W5/W6/W7 has already taken further is not ours to move.
        if (previous && !isOwnedStage(previous.stage)) continue;

        const built = buildPlan({
          symbol: verdict.symbol,
          horizon: verdict.horizon,
          direction: verdict.direction,
          flow: flowMap.get(verdict.symbol) || null,
          quote: quoteMap.get(verdict.symbol) || null,
          config: signalConfig,
        });
        const stage = computeStage({
          verdict,
          plan: built.plan,
          planReason: built.reason,
          config: signalConfig,
        });
        const next = {
          stage: stage.stage,
          direction: verdict.direction,
          score: Number(verdict.score),
          confidence: Number(verdict.confidence),
          planReady: stage.planReady,
          liquidityOk: stage.liquidityOk,
          plan: built.plan,
          planSignature: planSignature(built.plan),
          reasons: stage.reasons,
        };

        if (!isStageMaterialChange(previous, next, signalConfig.stages, now)) continue;
        changed.push({ verdict, next, previous: previous || null });
      }

      await this.persistStages(changed, { version, now });
      summary.superseded = await this.supersedeCandidates(changed);
      summary.candidates = await this.persistCandidates(changed, {
        version,
        now,
        strategy: signalConfig.strategy,
      });
      summary.persisted = changed.length;

      const counts = changed.reduce((acc, { next }) => {
        acc[next.stage] = (acc[next.stage] || 0) + 1;
        return acc;
      }, {});
      await this.markSource(
        'signal-builder',
        'HEALTHY',
        `${changed.length} stage change(s) across ${verdicts.length} verdict(s), `
        + `${summary.candidates} candidate(s) (config ${version}) `
        + `READY=${counts.READY || 0} BUILDING=${counts.BUILDING || 0} `
        + `WATCH=${counts.WATCH || 0} IDLE=${counts.IDLE || 0}`,
      );
      return summary;
    } catch (error) {
      await this.markSource('signal-builder', 'ERROR', error.message);
      log.error('signal recompute failed', { error: error.message });
      return { ...summary, error: error.message };
    }
  }

  // The queue messages are triggers, not payloads: W4 recomputes once per tick after draining
  // whatever arrived, reading the durable tables for the numbers.
  async drain(options = {}) {
    const max = options.max ?? this.maxPerDrain;
    const summary = { triggers: 0, failed: 0, batches: 0 };
    if (this.dryRun) {
      log.info('signal drain (dry run)');
      return summary;
    }
    if (!this.sql) {
      log.warn('signal drain skipped: no database connection');
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
            log.warn('could not clear signal trigger', { id: message.id, error: error.message });
          }
        }
      }
    }
    return summary;
  }

  async runOnce(options = {}) {
    const drained = await this.drain(options);
    const triggered = drained.triggers > 0;
    const stale = Date.now() - this.lastComputeAt >= this.recomputeStaleMs;

    if (!options.force && !triggered && !stale) {
      return { ...drained, computed: 0, persisted: 0, candidates: 0, skippedCompute: true };
    }

    const computed = await this.recompute(options);
    if (!computed.error) this.lastComputeAt = Date.now();
    return { ...drained, ...computed };
  }
}

module.exports = { SignalWorker };
