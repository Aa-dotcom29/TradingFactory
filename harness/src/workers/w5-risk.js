'use strict';

// Worker 5 - the risk gate.
//
// Every candidate the signal builder raises waits in `signal_candidates` with status
// `pending_risk`. W5 is the only thing that can move it on. It re-reads the candidate from the
// durable table (never from the queue payload), runs it through the pure gate in `risk.js`, and
// then either
//
//   APPROVED -> marks the candidate approved and emits `signal.approved` for the publisher (W6),
//   REJECTED -> marks it rejected and records why; it is never published,
//   DEFERRED -> leaves it pending (the market is closed) and re-evaluates on the next tick.
//
// Every evaluation that reaches a terminal state writes a `risk_decisions` row, so "why was this
// never published" is always answerable after the fact. A deferred proposal writes a row only
// when its reason changes, so an overnight market does not grow the table a line per tick.
//
// The limits live in `config_registry` (family `risk`) and are read here, in the worker. No
// dashboard route writes them: a gate that could be relaxed from the UI would not be a gate.

const config = require('../config');
const db = require('../db');
const queue = require('../queue');
const { TOPICS } = require('../topics');
const {
  DEFAULT_RISK_CONFIG,
  resolveRiskConfig,
  evaluateRisk,
  summariseExposure,
  summariseOutcomes,
  istDayStart,
} = require('../risk');

const log = require('../logger').child({ module: 'w5' });

const TRIGGER_TOPICS = [TOPICS.SIGNAL_CANDIDATE];
const CONFIG_FAMILY = 'risk';
const ENGINE_VERSION = 'risk-engine-1';

class RiskWorker {
  constructor(options = {}) {
    this.workerName = options.workerName || config.workerName;
    this.batchSize = options.batchSize || 25;
    this.maxPerDrain = options.maxPerDrain || 500;
    this.leaseSeconds = options.leaseSeconds || 120;
    this.recomputeStaleMs = options.recomputeStaleMs || 60000;
    this.configTtlMs = options.configTtlMs || 60000;
    this.maxCandidates = options.maxCandidates || 200;
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

  // Registers the built-in baseline as `risk-v1` in the `risk` family on first run, so the
  // limits actually in force are always inspectable and supersedeable without a deploy.
  async ensureConfig(options = {}) {
    const now = options.now ?? Date.now();
    if (this.configCache && now - this.configCacheAt < this.configTtlMs) return this.configCache;

    const fallback = { version: DEFAULT_RISK_CONFIG.version, config: resolveRiskConfig(null) };
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
        resolved = { version: rows[0].version, config: resolveRiskConfig(rows[0].config) };
      } else {
        const version = DEFAULT_RISK_CONFIG.version;
        await sql`
          insert into config_registry (version, family, created_by, status, metrics, config, approved_at)
          values (${version}, ${CONFIG_FAMILY}, 'harness', 'approved', ${sql.json({ seeded: true })},
                  ${sql.json(DEFAULT_RISK_CONFIG)}, now())
          on conflict (version) do nothing
        `;
        resolved = { version, config: resolveRiskConfig(DEFAULT_RISK_CONFIG) };
      }
    } catch (error) {
      log.warn('could not resolve risk config, using built-in baseline', { error: error.message });
      resolved = fallback;
    }

    this.configCache = resolved;
    this.configCacheAt = now;
    return resolved;
  }

  async loadPendingCandidates() {
    const sql = this.sql;
    return sql`
      select id, as_of, created_at, horizon, symbol, direction, strategy, kind, instrument,
             strike, option_type, expiry, entry, target, stop, rr, confidence, score,
             liquidity_ok, status, dedupe_key, config_version, setup, reasons
      from signal_candidates
      where status = 'pending_risk'
      order by created_at asc
      limit ${this.maxCandidates}
    `;
  }

  // Everything the gate needs that is not on the candidate itself. Exposure reads the actionable
  // open ledger, not every signal ever published: a voided or retired plan must not consume a
  // slot or suppress a new call. The loss controls read the evaluator's closed outcomes.
  async loadContext(now, riskConfig) {
    const sql = this.sql;
    const [signals, recentOutcomes, todayRows, lastLoss] = await Promise.all([
      sql`
        select horizon, symbol, direction, published_at
        from active_signals
        where published_at > now() - interval '180 days'
      `,
      // The loss streak is a DAILY control. Counting it across all history
      // meant one bad afternoon switched the system off for good, with no
      // way back except a win it was not allowed to take. Scoped to the
      // trading day, a bad day stands the system down until the next one.
      sql`
        select result, pnl_pct, evaluated_at
        from outcomes
        where evaluated_at >= ${istDayStart(now)}::timestamptz
        order by evaluated_at desc
        limit 30
      `,
      // The daily-loss window is the Indian trading day, not the UTC day: a UTC boundary lands at
      // 05:30 IST, mid-morning, which would both forget an overnight loss and split one trading day
      // across two buckets.
      sql`
        select count(*)::int as n,
               coalesce(sum(pnl_pct), 0) as pnl,
               coalesce(sum(pnl_pct * abs(coalesce((payload->>'entry')::numeric, 1))), 0) as weighted,
               coalesce(sum(abs(coalesce((payload->>'entry')::numeric, 1))), 0) as weight
        from outcomes
        where evaluated_at >= ${istDayStart(now)}::timestamptz
      `,
      // Only a MATERIAL loss starts a cooldown.
      sql`
        select max(evaluated_at) as last_loss_at
        from outcomes
        where pnl_pct <= ${-Math.abs(Number(riskConfig.gates.lossMaterialPct || 0))}
      `,
    ]);

    return {
      exposure: summariseExposure(signals, riskConfig, now),
      outcomes: summariseOutcomes(
        recentOutcomes,
        // The day's return is weighted by the capital at risk in each closed
        // plan, not a raw sum of per-trade percentages.
        todayRows.length && Number(todayRows[0].weight) > 0
          ? Number(todayRows[0].weighted) / Number(todayRows[0].weight)
          : null,
        lastLoss.length ? lastLoss[0].last_loss_at : null,
        todayRows.length ? todayRows[0].n : 0,
        Number(riskConfig.gates.lossMaterialPct || 0),
      ),
    };
  }

  // The latest stored decision per candidate, used to write a row only when the verdict or its
  // reasons actually changed.
  async latestDecisions() {
    const sql = this.sql;
    const rows = await sql`
      select distinct on (candidate_id) candidate_id, decision, reasons
      from risk_decisions
      where candidate_id is not null
      order by candidate_id, evaluated_at desc
    `;
    const map = new Map();
    for (const row of rows) map.set(row.candidate_id, row);
    return map;
  }

  decisionChanged(previous, result) {
    if (!previous) return true;
    if (previous.decision !== result.decision) return true;
    return JSON.stringify(previous.reasons || []) !== JSON.stringify(result.reasons || []);
  }

  async persistDecisions(rows, { version, now }) {
    const sql = this.sql;
    if (!rows.length) return 0;
    await sql`
      insert into risk_decisions ${sql(rows.map(({ candidate, result }) => ({
        candidate_id: candidate.id,
        signal_id: null,
        horizon: candidate.horizon,
        evaluated_at: new Date(now).toISOString(),
        passed: result.decision === 'APPROVED',
        decision: result.decision,
        reasons: result.reasons,
        config_version: version,
        payload: { checks: result.checks, engineVersion: ENGINE_VERSION },
      })))}
    `;
    return rows.length;
  }

  async approve(candidate, { version, now }) {
    const sql = this.sql;
    const updated = await sql`
      update signal_candidates
      set status = 'approved'
      where id = ${candidate.id}::uuid and status = 'pending_risk'
      returning id
    `;
    if (!updated.length) return false;

    await queue.enqueue(TOPICS.SIGNAL_APPROVED, {
      candidateId: candidate.id,
      horizon: candidate.horizon,
      symbol: candidate.symbol,
      direction: candidate.direction,
      kind: candidate.kind,
      riskConfigVersion: version,
      dedupeKey: candidate.dedupe_key,
      asOf: new Date(now).toISOString(),
    }, { idemKey: `approved:${candidate.dedupe_key}`, horizon: candidate.horizon });
    return true;
  }

  async reject(candidate) {
    const sql = this.sql;
    const updated = await sql`
      update signal_candidates
      set status = 'rejected'
      where id = ${candidate.id}::uuid and status = 'pending_risk'
      returning id
    `;
    return updated.length > 0;
  }

  async recompute(options = {}) {
    const now = options.now ?? Date.now();
    const summary = {
      evaluated: 0, approved: 0, rejected: 0, deferred: 0, recorded: 0, configVersion: null,
    };
    if (this.dryRun) {
      log.info('risk recompute (dry run)');
      return summary;
    }
    const sql = this.sql;
    if (!sql) return { ...summary, skipped: 'no-database' };

    try {
      const { version, config: riskConfig } = await this.ensureConfig({ now });
      summary.configVersion = version;

      const candidates = await this.loadPendingCandidates();
      if (!candidates.length) {
        await this.markSource('risk-gate', 'HEALTHY', `no candidates awaiting risk (config ${version})`);
        return summary;
      }

      const context = await this.loadContext(now, riskConfig);
      const previous = await this.latestDecisions();
      const changed = [];

      for (const candidate of candidates) {
        const result = evaluateRisk({ candidate, context, config: riskConfig, now });
        summary.evaluated += 1;

        if (this.decisionChanged(previous.get(candidate.id), result)) {
          changed.push({ candidate, result });
        }

        if (result.decision === 'APPROVED') {
          if (await this.approve(candidate, { version, now })) summary.approved += 1;
        } else if (result.decision === 'REJECTED') {
          if (await this.reject(candidate)) summary.rejected += 1;
        } else {
          summary.deferred += 1;
        }
      }

      summary.recorded = await this.persistDecisions(changed, { version, now });

      await this.markSource(
        'risk-gate',
        'HEALTHY',
        `${summary.evaluated} candidate(s) evaluated: ${summary.approved} approved, `
        + `${summary.rejected} rejected, ${summary.deferred} deferred (config ${version})`,
      );
      return summary;
    } catch (error) {
      await this.markSource('risk-gate', 'ERROR', error.message);
      log.error('risk recompute failed', { error: error.message });
      return { ...summary, error: error.message };
    }
  }

  // The queue messages are triggers, not payloads: W5 recomputes once per tick after draining
  // whatever arrived, reading the durable tables for the numbers.
  async drain(options = {}) {
    const max = options.max ?? this.maxPerDrain;
    const summary = { triggers: 0, failed: 0, batches: 0 };
    if (this.dryRun) {
      log.info('risk drain (dry run)');
      return summary;
    }
    if (!this.sql) {
      log.warn('risk drain skipped: no database connection');
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
            log.warn('could not clear risk trigger', { id: message.id, error: error.message });
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
      return { ...drained, evaluated: 0, skippedCompute: true };
    }

    const computed = await this.recompute(options);
    if (!computed.error) this.lastComputeAt = Date.now();
    return { ...drained, ...computed };
  }
}

module.exports = { RiskWorker, ENGINE_VERSION };
